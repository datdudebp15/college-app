// NCAA game data: scoreboards, box scores and play-by-play from ncaa.com, through the open-source ncaa-api
// (github.com/henrygd/ncaa-api). The public instance allows 3 requests a second, so calls here are spaced out;
// NCAA_API_BASE can point at our own instance later. Everything fetched is cached in our database, so a game
// is fetched once no matter how many teams look at it.
//
// Play-by-play lines carry the pitch sequence for every plate appearance, e.g.
//   "Ball,Ethan struck out swinging (2-2 KSBBS)."   B ball, K called strike, S swinging strike, F foul
// The ball put in play is not written in the sequence; it is implied by the result.

const BASE = (process.env.NCAA_API_BASE || "https://ncaa-api.henrygd.me").replace(/\/$/, "");
let last = 0;
async function get(path) {
  const wait = last + 360 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(25000), headers: { "User-Agent": "OffseasonCollege/1.0" } }).catch(() => null);
    if (r && r.ok) return r.json();
    if (r && r.status === 404) return null;
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  throw Object.assign(new Error("ncaa api " + path), { code: "ncaa_unavailable" });
}

/** Every D1 baseball game on a date (YYYY-MM-DD): [{ id, date, epoch, state, home: { seo, name, score }, away: {...} }] */
export async function scoreboard(date) {
  const [y, m, d] = date.split("-");
  const j = await get(`/scoreboard/baseball/d1/${y}/${m}/${d}/all-conf`);
  return ((j && j.games) || []).map(({ game: g }) => ({
    id: String(g.gameID), date, epoch: Number(g.startTimeEpoch) || null, state: g.gameState || null, time: g.startTime || null,
    home: { seo: g.home.names.seo, name: g.home.names.short, score: num(g.home.score) },
    away: { seo: g.away.names.seo, name: g.away.names.short, score: num(g.away.score) },
  }));
}
export const boxscore = (id) => get(`/game/${encodeURIComponent(id)}/boxscore`);
export const playByPlay = (id) => get(`/game/${encodeURIComponent(id)}/play-by-play`);
export const schoolsIndex = () => get(`/schools-index`);
const num = (v) => (v === "" || v == null ? null : Number.isFinite(+v) ? +v : null);

/* ---------- parsing ---------- */
export const PARSER_VERSION = 3;

const RESULT = [
  [/^struck out looking/, "KL"], [/^struck out swinging/, "KS"], [/^struck out/, "K"],
  [/^intentionally walked/, "IBB"], [/^walked/, "BB"], [/^hit by pitch/, "HBP"],
  [/^homered/, "HR"], [/^tripled/, "3B"], [/^(ground-rule )?doubled/, "2B"], [/^singled/, "1B"],
  [/^grounded into (a )?double play/, "GDP"], [/^lined into (a )?double play/, "LDP"], [/^flied into (a )?double play/, "FDP"], [/^(hit into|into) (a )?double play/, "DP"],
  [/^grounded out/, "GO"], [/^flied out/, "FO"], [/^lined out/, "LO"], [/^popped (up|out)/, "PO"], [/^fouled out/, "FFO"],
  [/^sacrifice fly/, "SF"], [/^sacrifice bunt/, "SH"], [/^out on (a )?sacrifice/, "SH"],
  [/^reached on (a |an )?fielder'?s choice/, "FC"], [/^reached on (a |an )?(\w+ )?error/, "ROE"], [/^reached on catcher'?s interference/, "CI"],
  [/^reached/, "RE"], [/^out/, "OUT"],
];
const HIT = new Set(["1B", "2B", "3B", "HR"]);
const NOT_AB = new Set(["BB", "IBB", "HBP", "SF", "SH", "CI"]);

/**
 * One play-by-play line -> a plate appearance, or null for everything else (substitutions, steals, notes).
 * { last, first, outcome, seq, balls, strikes, pitches, swings, whiffs, fouls, called, inPlay, bb, field, text }
 */
export function parsePA(text) {
  if (!text || /^(Previous|Mound|Offensive|Defensive|Action clock|Umpire|Game|Weather|Start|End)\b/i.test(text)) return null;
  const head = text.split(";")[0];
  const m = head.match(/^([A-Za-z'.\- ]+?),\s*([A-Za-z'.\- ]+?)\s+(.+?)\s*\((\d)-(\d)(?:\s+([A-Z]*))?\)\.?\s*$/);
  if (!m) return null;
  const [, last, first, rest, b, s, seqRaw = ""] = m;
  const res = rest.toLowerCase();
  const hit = RESULT.find(([re]) => re.test(res));
  if (!hit) return null;
  const outcome = hit[1];
  const seq = seqRaw.replace(/[^BKSF]/g, ""); // N (clock violation) and anything unknown is not a pitch
  const inPlay = !/^(K|KL|KS|BB|IBB|HBP|CI)$/.test(outcome);
  const called = count(seq, "K"), whiffs = count(seq, "S"), fouls = count(seq, "F");
  return {
    last: last.trim(), first: first.trim(), outcome, seq, balls: +b, strikes: +s,
    pitches: seq.length + (inPlay ? 1 : 0), swings: whiffs + fouls + (inPlay ? 1 : 0), whiffs, fouls, called, inPlay,
    hit: HIT.has(outcome), ab: !NOT_AB.has(outcome),
    bb: battedType(outcome, res), field: fieldOf(res), text: text.slice(0, 300),
  };
}
const count = (s, c) => [...s].filter((x) => x === c).length;
function battedType(outcome, res) {
  if (/bunt/.test(res) || outcome === "SH") return "BU";
  if (/^(GO|GDP)$/.test(outcome) || /ground|grounder/.test(res)) return "GB";
  if (/^(LO|LDP)$/.test(outcome) || /line drive|lined/.test(res)) return "LD";
  if (/^(PO|FFO)$/.test(outcome) || /popped|pop up|infield fly/.test(res)) return "PU";
  if (/^(FO|SF|FDP)$/.test(outcome) || /fly ball|flied/.test(res)) return "FB";
  if (outcome === "HR") return "FB";
  // hits: infield locations mean it stayed on the ground
  if (HIT.has(outcome) && /(to|through) (the )?(third base|short|shortstop|second base|first base|pitcher|catcher|left side|right side)|infield|bunt/.test(res)) return "GB";
  return null;
}
// Where the ball went, from the batter's view of the field: L (third/short/left), C (middle/pitcher/center), R (second/first/right).
function fieldOf(res) {
  const r = res.replace(/,.*$/, (x) => x); // the first fielder named is where it was hit
  const tests = [
    [/up the middle|to (center|cf)\b|center field|to p\b|pitcher|, p (to|unassisted)|^\w+ out(,)? p\b|to c\b|catcher/, "C"],
    [/left side|to (left|lf)\b|left field|third base|to 3b|to (ss|short)\b|shortstop|, (3b|ss) (to|unassisted)|down the left/, "L"],
    [/right side|to (right|rf)\b|right field|first base|second base|to (1b|2b)\b|, (1b|2b) (to|unassisted)|down the right/, "R"],
  ];
  for (const [re, f] of tests) if (re.test(r)) return f;
  return null;
}

/**
 * A whole game: who pitched to whom. Returns { teams: { [ncaaTeamId]: seo }, names, pas, pitchers }.
 * The box score lists pitchers in no particular order and its per-game lines aren't reliable, so pitchers and
 * their lines come from the play-by-play: "X pitching change: A replaces B." means B was pitching before A.
 */
export function parseGame(box, pbp) {
  const teams = {}, names = {};
  for (const t of (box && box.teams) || pbp.teams || []) { teams[String(t.teamId)] = t.seoname; names[t.seoname] = t.nameShort; }
  const otherOf = (id) => Object.keys(teams).find((k) => k !== String(id));
  const blocks = [];
  for (const per of pbp.periods || []) for (const blk of per.playbyplayStats || [])
    for (const pl of blk.plays || []) blocks.push({ inning: per.periodNumber, batSeo: teams[String(blk.teamId)], pitchSeo: teams[otherOf(blk.teamId)], text: String(pl.playText || "").trim() });
  // starters: whoever the first change replaced, or the only pitcher in the box score when nobody came in
  const current = {};
  for (const b of blocks) { const ch = b.text.match(CHANGE); if (ch && !(b.pitchSeo in current)) current[b.pitchSeo] = squash(ch[2]); }
  for (const tb of (box && box.teamBoxscore) || []) {
    const seo = teams[String(tb.teamId)], ps = (tb.playerStats || []).filter((p) => p.pitcherStats);
    if (!(seo in current) && ps.length === 1) current[seo] = squash(`${ps[0].lastName},${ps[0].firstName}`);
  }
  const starters = { ...current };
  const pas = [], lines = new Map();
  for (const b of blocks) {
    const ch = b.text.match(CHANGE);
    if (ch) { current[b.pitchSeo] = squash(ch[1]); continue; }
    const pa = parsePA(b.text);
    if (!pa) continue;
    const pitcher = current[b.pitchSeo] || null;
    pas.push({ ...pa, inning: b.inning, batSeo: b.batSeo, pitchSeo: b.pitchSeo, pitcher });
    if (pitcher) {
      const k = b.pitchSeo + "|" + pitcher;
      const L = lines.get(k) || { seo: b.pitchSeo, name: pitcher, started: starters[b.pitchSeo] === pitcher, bf: 0, outs: 0, h: 0, bb: 0, k: 0, hbp: 0, hr: 0, pitches: 0 };
      L.bf++; L.pitches += pa.pitches; L.outs += OUTS[pa.outcome] ?? 0;
      if (pa.hit) L.h++; if (/^(BB|IBB)$/.test(pa.outcome)) L.bb++; if (/^K/.test(pa.outcome)) L.k++; if (pa.outcome === "HBP") L.hbp++; if (pa.outcome === "HR") L.hr++;
      lines.set(k, L);
    }
  }
  return { teams, names, pas, pitchers: [...lines.values()] };
}
const CHANGE = /pitching change:\s*([^.]+?)\s+replaces\s+([^.]+?)\.?$/i;
const squash = (s) => String(s).replace(/\s+/g, "");
// outs recorded on the batter's play (runners thrown out elsewhere on the play aren't counted)
const OUTS = { KL: 1, KS: 1, K: 1, GO: 1, FO: 1, LO: 1, PO: 1, FFO: 1, SF: 1, SH: 1, OUT: 1, FC: 1, GDP: 2, LDP: 2, FDP: 2, DP: 2 };

/** "Daniel,Pete" or ("Daniel","Pete") -> a comparable key: lowercase letters only, suffixes dropped. */
export function nameKey(last, first) {
  if (first === undefined) [last, first] = String(last).split(",");
  const clean = (s) => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/(jr|iii|ii)$/, "").replace(/[^a-z]/g, "");
  return clean(last) + "," + clean(first);
}
