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
export const PARSER_VERSION = 5;

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
 * Scorekeepers write names many ways ("Gibson,Ethan", "E. Gibson", "GIBSON, E.", "Gibson"), so the name is
 * whatever comes before the result, reduced to a last name and a first initial.
 * { name: { last, init }, key, outcome, seq, balls, strikes, pitches, swings, whiffs, fouls, called, inPlay, bb, field, text }
 * seq, balls, strikes and the pitch counts are null when the line has no count, which some scorers leave off.
 */
const VERB = /\s(struck out|intentionally walked|walked|hit by pitch|homered|tripled|ground-rule doubled|doubled|singled|grounded|lined|flied|popped|fouled out|sacrifice|reached|out on|hit into)\b/i;
export function parsePA(text) {
  if (!text || /^(Previous|Mound|Offensive|Defensive|Action clock|Umpire|Game|Weather|Start|End|Batting)\b/i.test(text)) return null;
  const head = text.split(";")[0].trim();
  const cm = head.match(/\((\d)-(\d)(?:\s+([A-Z]*))?\)\.?\s*$/);
  const body = cm ? head.slice(0, cm.index).trim() : head.replace(/\.$/, "");
  const vm = body.match(VERB);
  if (!vm) return null;
  const rawName = body.slice(0, vm.index).trim();
  if (!rawName || /\d/.test(rawName) || rawName.split(/\s+/).length > 4) return null;
  const res = body.slice(vm.index + 1).toLowerCase();
  const hit = RESULT.find(([re]) => re.test(res));
  if (!hit) return null;
  const outcome = hit[1], name = parseName(rawName);
  const inPlay = !/^(K|KL|KS|BB|IBB|HBP|CI)$/.test(outcome);
  const base = { name, key: keyOf(name), last: name.lastRaw, first: name.firstRaw, outcome, inPlay, hit: HIT.has(outcome), ab: !NOT_AB.has(outcome), bb: battedType(outcome, res), field: fieldOf(res), text: text.slice(0, 300) };
  if (!cm) return { ...base, seq: null, balls: null, strikes: null, pitches: null, swings: null, whiffs: null, fouls: null, called: null };
  const seq = (cm[3] || "").replace(/[^BKSF]/g, ""); // N (clock violation) and anything unknown is not a pitch
  const called = count(seq, "K"), whiffs = count(seq, "S"), fouls = count(seq, "F");
  return { ...base, seq, balls: +cm[1], strikes: +cm[2], pitches: seq.length + (inPlay ? 1 : 0), swings: whiffs + fouls + (inPlay ? 1 : 0), whiffs, fouls, called };
}
/** "Gibson,Ethan" | "E. Gibson" | "GIBSON, E." | "Gibson" | "Ethan Gibson" -> { last, init, lastRaw, firstRaw } */
export function parseName(raw) {
  const s = String(raw || "").trim().replace(/\.+$/, "");
  let last, first = "";
  if (s.includes(",")) [last, first] = s.split(",").map((x) => x.trim());
  else { const w = s.split(/\s+/); if (w.length === 1) last = w[0]; else { first = w[0]; last = w.slice(1).join(" "); } }
  const tc = (x) => (x && x === x.toUpperCase() ? x.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase()) : x);
  return { last: cleanLast(last), init: (first.replace(/[^A-Za-z]/g, "")[0] || "").toLowerCase(), lastRaw: tc(last), firstRaw: tc(first.replace(/\.$/, "")) };
}
const cleanLast = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/(jr|iii|ii)$/, "").replace(/[^a-z]/g, "");
const keyOf = (n) => n.last + "|" + n.init;
/** ("Daniel", "Pete") -> "daniel|p", the key plate appearances are stored under. */
export const nameKey = (last, first) => cleanLast(last) + "|" + (String(first || "").normalize("NFD").replace(/[^A-Za-z]/g, "")[0] || "").toLowerCase();
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
 * Which team a batter or pitcher is on comes from the box score's player lists, because the team label on
 * play-by-play lines isn't consistent between scorekeepers. Pitching changes appear as
 * "PITT pitching change: A replaces B." or "A to p for B."; the first B for a team was its starter.
 */
export function parseGame(box, pbp) {
  const teams = {}, names = {};
  for (const t of (box && box.teams) || pbp.teams || []) { teams[String(t.teamId)] = t.seoname; names[t.seoname] = t.nameShort; }
  const seos = Object.values(teams), other = (seo) => seos.find((s) => s !== seo);
  // box score rosters: key -> full name, and who pitched
  const roster = {}, pitched = {}, full = {};
  for (const tb of (box && box.teamBoxscore) || []) {
    const seo = teams[String(tb.teamId)]; roster[seo] = new Set(); pitched[seo] = new Set();
    for (const p of tb.playerStats || []) { const k = nameKey(p.lastName, p.firstName); roster[seo].add(k); full[seo + ":" + k] = `${p.firstName} ${p.lastName}`.trim(); if (p.pitcherStats && k !== "|") pitched[seo].add(k); }
  }
  // a name written without an initial matches the one player on that team with that last name
  const resolve = (n, seo) => { const k = keyOf(n); if (n.init || !roster[seo]) return k; const m = [...roster[seo]].filter((x) => x.startsWith(n.last + "|")); return m.length === 1 ? m[0] : k; };
  const teamOf = (n, sets, fallback) => { for (const seo of seos) { if (sets[seo] && sets[seo].has(resolve(n, seo))) return seo; } return fallback; };

  const blocks = [];
  for (const per of pbp.periods || []) for (const blk of per.playbyplayStats || [])
    for (const pl of blk.plays || []) blocks.push({ inning: per.periodNumber, label: teams[String(blk.teamId)], text: String(pl.playText || "").trim() });
  // who bats in the next plate appearance after each line: a new pitcher belongs to the other team
  let nextBat = null;
  for (let i = blocks.length - 1; i >= 0; i--) { blocks[i].nextBat = nextBat; const pa = parsePA(blocks[i].text); if (pa) nextBat = teamOf(pa.name, roster, blocks[i].label); }
  const change = (text) => { const m = text.match(/pitching change:\s*(.+?)\s+replaces\s+(.+?)\.?$/i) || text.match(/^(.+?)\s+to p for\s+(.+?)\.?$/i); return m && { in: parseName(m[1]), out: parseName(m[2]) }; };

  // whose change it is: the box score knows the pitchers (it sometimes leaves relievers out); else whoever had
  // the replaced pitcher; else the team in the field when the next batter comes up
  const changeTeam = (ch, b, cur) => teamOf(ch.in, pitched, teamOf(ch.out, pitched, null)) || seos.find((s) => cur[s] && cur[s] === resolve(ch.out, s)) || (b.nextBat ? other(b.nextBat) : null);
  const starters = {}, seen = {};
  for (const b of blocks) {
    const ch = change(b.text); if (!ch) continue;
    const seo = changeTeam(ch, b, seen); if (!seo) continue;
    if (!(seo in starters)) starters[seo] = resolve(ch.out, seo);
    seen[seo] = resolve(ch.in, seo);
    for (const n of [ch.in, ch.out]) { const k = seo + ":" + resolve(n, seo); if (!full[k]) full[k] = nice(n); }
  }
  for (const seo of seos) if (!(seo in starters) && pitched[seo] && pitched[seo].size === 1) starters[seo] = [...pitched[seo]][0];
  const current = { ...starters };

  const pas = [], lines = new Map();
  for (const b of blocks) {
    const ch = change(b.text);
    if (ch) { const seo = changeTeam(ch, b, current); if (seo) current[seo] = resolve(ch.in, seo); continue; }
    const pa = parsePA(b.text);
    if (!pa) continue;
    const batSeo = teamOf(pa.name, roster, b.label), pitchSeo = other(batSeo);
    const key = resolve(pa.name, batSeo), pitcher = current[pitchSeo] || null;
    pas.push({ ...pa, key, inning: b.inning, batSeo, pitchSeo, pitcher, pitcherName: pitcher ? full[pitchSeo + ":" + pitcher] || pitcher : null });
    if (pitcher) {
      const k = pitchSeo + "|" + pitcher;
      const L = lines.get(k) || { seo: pitchSeo, name: pitcher, display: full[pitchSeo + ":" + pitcher] || pitcher, started: starters[pitchSeo] === pitcher, bf: 0, outs: 0, h: 0, bb: 0, k: 0, hbp: 0, hr: 0, pitches: 0 };
      L.bf++; L.pitches += pa.pitches || 0; L.outs += OUTS[pa.outcome] ?? 0;
      if (pa.hit) L.h++; if (/^(BB|IBB)$/.test(pa.outcome)) L.bb++; if (/^K/.test(pa.outcome)) L.k++; if (pa.outcome === "HBP") L.hbp++; if (pa.outcome === "HR") L.hr++;
      lines.set(k, L);
    }
  }
  return { teams, names, pas, pitchers: [...lines.values()] };
}
const nice = (n) => [n.firstRaw && (n.firstRaw.length === 1 ? n.firstRaw + "." : n.firstRaw), n.lastRaw].filter(Boolean).join(" ");
// outs recorded on the batter's play (runners thrown out elsewhere on the play aren't counted)
const OUTS = { KL: 1, KS: 1, K: 1, GO: 1, FO: 1, LO: 1, PO: 1, FFO: 1, SF: 1, SH: 1, OUT: 1, FC: 1, GDP: 2, LDP: 2, FDP: 2, DP: 2 };
