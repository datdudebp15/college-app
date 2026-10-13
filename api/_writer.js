import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { query, one } from "./_db.js";
import { fmt3 } from "./_hitting.js";

// Claude's write-ups for a player: his season, his last game, his next opponent. Claude only explains numbers
// the code already computed and is told to use no others. It doesn't write training plans: it helps him see how
// he did and what to improve. Each note is saved with a hash of its inputs and rewritten only when they change.
// Without an API key, or once the team's monthly budget is spent, a plain version is built from the same numbers.

const MODEL = "claude-opus-5-5";
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }; // Claude Opus 5.5, $ per million tokens
export const TEAM_MONTHLY_USD = Number(process.env.OC_TEAM_MONTHLY_USD) || 10;

const SYSTEM = `You write short notes for a college baseball hitter and his coaches, inside a hitting app.
Rules:
- Use only the numbers in the data you are given. Never invent a statistic, a pitch type, a velocity, a location or an event.
- The data comes from NCAA play-by-play: results, pitch sequences (ball, called strike, swinging strike, foul), batted-ball type and direction. There is no pitch tracking, so say nothing about pitch types, speeds, spin or exact locations.
- Explain what happened and what it means. Do not write a training plan, drills or a schedule. "What to improve" names the area and why, in a sentence.
- Plain English a 19-year-old hitter reads in 20 seconds. Short sentences. No jargon without saying what it means. No hype, no emojis.
- Talk to the hitter as "you".`;

const SCHEMAS = {
  season: { type: "object", additionalProperties: false, required: ["summary", "strengths", "improve", "change"],
    properties: {
      summary: { type: "string", description: "2-3 sentences: how his season went, overall." },
      strengths: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: { type: "string" }, detail: { type: "string" } } } },
      improve: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: { type: "string" }, detail: { type: "string" } } } },
      change: { type: "string", description: "How he changed from his previous season, in 1-2 sentences, or an empty string if there is no earlier season." } } },
  postgame: { type: "object", additionalProperties: false, required: ["headline", "how", "workOn"],
    properties: { headline: { type: "string", description: "A few words, like '2-for-4, made them work'." }, how: { type: "string", description: "2-3 sentences on his at-bats." }, workOn: { type: "string", description: "One sentence: the one thing from this game to work on." } } },
  opponent: { type: "object", additionalProperties: false, required: ["overview", "pitchers"],
    properties: { overview: { type: "string", description: "1-2 sentences on their staff." },
      pitchers: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "attack"], properties: { name: { type: "string" }, attack: { type: "string", description: "1-2 sentences: how he is likely to go after this hitter, from the numbers." } } } } } },
};

/** The saved note for this input, a fresh one from Claude (if allowed), or the plain version. Never throws. */
export async function note(kind, player, team, key, input, { write = false } = {}) {
  const hash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32);
  const saved = await one(`SELECT data, source_hash, model, created_at FROM notes WHERE player_id = $1 AND kind = $2 AND key = $3`, [player.id, kind, key]);
  if (saved && saved.source_hash === hash) return { ...saved.data, by: saved.model ? "claude" : "rules", at: saved.created_at };
  if (write && process.env.ANTHROPIC_API_KEY && (await canSpend(team.id, 0.15))) {
    try {
      const data = await askClaude(kind, input, team.id, `${kind} ${player.id} ${key}`);
      if (data) {
        await query(`INSERT INTO notes (player_id, kind, key, data, source_hash, model, created_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,now())
          ON CONFLICT (player_id, kind, key) DO UPDATE SET data = $4::jsonb, source_hash = $5, model = $6, created_at = now()`, [player.id, kind, key, JSON.stringify(data), hash, MODEL]);
        return { ...data, by: "claude", at: new Date().toISOString() };
      }
    } catch (e) { console.error("note: claude failed", kind, e && e.status); }
  }
  // an older Claude note is better than a plain one while the new one waits for the nightly job
  if (saved && saved.model) return { ...saved.data, by: "claude", at: saved.created_at, stale: true };
  return { ...PLAIN[kind](input), by: "rules" };
}

async function askClaude(kind, input, teamId, what) {
  const client = new Anthropic();
  const ask = { season: "Write the season note for this hitter.", postgame: "Write the postgame note for this hitter's last game.", opponent: "Write the opponent note: how their pitchers are likely to attack this hitter." }[kind];
  const response = await client.beta.messages.create({
    model: MODEL, max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMAS[kind] } },
    system: SYSTEM,
    messages: [{ role: "user", content: `${ask}\n\nData (JSON):\n${JSON.stringify(input)}` }],
  });
  await record(teamId, response.usage, what);
  if (response.stop_reason === "refusal") return null;
  const text = response.content.find((b) => b.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

/* ---------- per-team monthly budget ---------- */
const month = () => new Date().toISOString().slice(0, 7);
async function spent(teamId) { const r = await one(`SELECT v FROM kv WHERE k = $1`, [`budget:${teamId}:${month()}`]); return (r && r.v.spent) || 0; }
async function canSpend(teamId, estimate) { return (await spent(teamId)) + estimate <= TEAM_MONTHLY_USD; }
async function record(teamId, u, what) {
  if (!u) return;
  const cost = ((u.input_tokens || 0) * PRICE.input + (u.output_tokens || 0) * PRICE.output + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite + (u.cache_read_input_tokens || 0) * PRICE.cacheRead) / 1e6;
  const k = `budget:${teamId}:${month()}`, cur = (await one(`SELECT v FROM kv WHERE k = $1`, [k]))?.v || { spent: 0, calls: 0 };
  await query(`INSERT INTO kv (k, v, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (k) DO UPDATE SET v = $2::jsonb, updated_at = now()`,
    [k, JSON.stringify({ spent: Math.round((cur.spent + cost) * 10000) / 10000, calls: cur.calls + 1, last: what })]);
}

/* ---------- inputs: only what Claude needs, so the hash changes only when the substance does ---------- */
export function seasonInput(player, prof) {
  const [cur, ...prev] = prof.seasons;
  if (!cur) return null;
  const pick = (s) => s && { season: s.season, school: s.schoolName, games: s.games, stats: s.metrics, teamAverages: s.team, flags: s.flags.map(({ sev, title, detail }) => ({ sev, title, detail })) };
  return { hitter: { name: `${player.first_name} ${player.last_name}`, bats: player.bats, pos: player.pos, classYear: player.class_year }, season: pick(cur), previousSeasons: prev.map(pick) };
}
export function postgameInput(player, prof) {
  const g = prof.lastGame; if (!g) return null;
  return { hitter: { name: `${player.first_name} ${player.last_name}`, bats: player.bats }, game: { date: g.date, opponent: g.opponent, score: `${g.us}-${g.them}`, won: g.us > g.them },
    atBats: g.pas.map(({ inning, outcome, seq, balls, strikes, pitches, bb, field, pitcher, text }) => ({ inning, outcome, sequence: seq, countBeforeLastPitch: `${balls}-${strikes}`, pitches, battedBall: bb, field, pitcher, playByPlay: text })),
    seasonSoFar: prof.seasons[0] && prof.seasons[0].metrics && { avg: prof.seasons[0].metrics.avg, kPct: prof.seasons[0].metrics.kPct, whiffPct: prof.seasons[0].metrics.whiffPct, fpSwingPct: prof.seasons[0].metrics.fpSwingPct } };
}
export function opponentInput(player, prof) {
  const o = prof.opponent; if (!o || o.empty) return null;
  const s = prof.seasons[0]?.metrics;
  const P = (x) => x && { name: x.name, role: x.role, why: x.why || null, apps: x.apps, starts: x.starts, ip: x.ip, kPct: x.kPct, bbPct: x.bbPct, firstPitchStrikePct: x.fpStrikePct, whiffPct: x.whiffPct, strikeoutsLookingShare: x.kLookingShare, groundBallPct: x.gbPct, pitchesPerBatter: x.pitchesPerBF, matchupObservations: x.notes, facedThisHitter: x.faced };
  return { hitter: { name: `${player.first_name} ${player.last_name}`, bats: player.bats, stats: s && { kPct: s.kPct, whiffPct: s.whiffPct, fpSwingPct: s.fpSwingPct, klShare: s.klShare, gbPct: s.batted.gbPct, pitchesPerPA: s.pitchesPerPA } },
    game: { date: prof.next.date, opponent: o.name, home: prof.next.home }, pitchers: [P(o.starter), ...o.bullpen.map(P)].filter(Boolean) };
}

/* ---------- plain versions (no Claude) ---------- */
const OUT = { KL: "struck out looking", KS: "struck out swinging", K: "struck out", BB: "walked", IBB: "was intentionally walked", HBP: "was hit by a pitch", "1B": "singled", "2B": "doubled", "3B": "tripled", HR: "homered",
  GO: "grounded out", GDP: "grounded into a double play", FO: "flied out", LO: "lined out", PO: "popped up", FFO: "fouled out", SF: "hit a sacrifice fly", SH: "bunted", FC: "reached on a fielder's choice", ROE: "reached on an error" };
const PLAIN = {
  season(input) {
    const s = input.season, m = s.stats;
    const good = s.flags.filter((f) => f.sev === "good"), work = s.flags.filter((f) => f.sev !== "good" && f.sev !== "info");
    const prev = input.previousSeasons[0];
    return {
      summary: `You hit ${fmt3(m.avg)}/${fmt3(m.obp)}/${fmt3(m.slg)} in ${m.pa} plate appearances over ${s.games} games in ${s.season}, with ${m.hr} home runs, ${m.bb} walks and ${m.k} strikeouts.`,
      strengths: good.slice(0, 3).map(({ title, detail }) => ({ title, detail })),
      improve: work.slice(0, 3).map(({ title, detail }) => ({ title, detail })),
      change: prev ? `In ${prev.season} you hit ${fmt3(prev.stats.avg)} with a ${Math.round(prev.stats.kPct)}% strikeout rate; in ${s.season}, ${fmt3(m.avg)} and ${Math.round(m.kPct)}%.` : "",
    };
  },
  postgame(input) {
    const ab = input.atBats, hits = ab.filter((a) => /^(1B|2B|3B|HR)$/.test(a.outcome)).length, abs = ab.filter((a) => !/^(BB|IBB|HBP|SF|SH)$/.test(a.outcome)).length;
    const pitches = ab.reduce((s, a) => s + a.pitches, 0), ks = ab.filter((a) => /^K/.test(a.outcome));
    return {
      headline: `${hits}-for-${abs} vs ${input.game.opponent}`,
      how: ab.map((a) => `${OUT[a.outcome] || "made an out"} in the ${ord(a.inning)}${a.pitcher ? ` against ${a.pitcher}` : ""}`).join("; ").replace(/^./, (c) => "You " + c) + `. You saw ${pitches} pitches.`,
      workOn: ks.length >= 2 ? `${ks.length} strikeouts: look back at the two-strike pitches in those at-bats.` : ks.some((a) => a.outcome === "KL") ? "You took strike three once; know the zone with two strikes." : "Keep the same approach into the next game.",
    };
  },
  opponent(input) {
    const ps = input.pitchers;
    return {
      overview: `${input.game.opponent}: ${ps.length} pitchers who have pitched recently.`,
      pitchers: ps.map((p) => ({ name: p.name, attack: p.matchupObservations.length ? p.matchupObservations.join(" ") : `${p.kPct ?? "–"}% strikeouts, ${p.bbPct ?? "–"}% walks, first-pitch strikes ${p.firstPitchStrikePct ?? "–"}%.` })),
    };
  },
};
const ord = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
