// Simulated seasons for the fictional demo league, pitch by pitch, so every feature (search, heat maps, spray
// charts, Today, Scouting, player pages) has data to show without any real player. Deterministic: the same
// seed always gives the same league. Writes the same tables the real feeds write (ncaa_games, ncaa_pas,
// ncaa_pitch_lines, pitches with source "demo"). Nothing here is a real school, player or game.
import { query } from "../api/_db.js";
import { nameKey } from "../api/_ncaa.js";
import { DEMO_LEAGUE } from "../api/_demo.js";

export const DEMO_SEASON_VERSION = 3;
const SEASONS = [2025, 2026];

/* ---------- random numbers ---------- */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let R = rng(20260413);
const rand = () => R();
const normal = (mu, sd) => { const u = 1 - rand(), v = rand(); return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pickW = (items) => { const tot = items.reduce((s, x) => s + x.w, 0); let r = rand() * tot; for (const x of items) { r -= x.w; if (r <= 0) return x; } return items[items.length - 1]; };
const pick = (a) => a[Math.floor(rand() * a.length)];

/* ---------- people ---------- */
const FIRST = ["Aiden", "Beckett", "Cal", "Dante", "Emmett", "Finn", "Grady", "Hollis", "Ike", "Jory", "Kellan", "Lane", "Milo", "Nash", "Otto", "Pierce", "Quinn", "Rhett", "Silas", "Tobin", "Upton", "Vance", "Wade", "Xavi", "Yates", "Zane", "Ansel", "Brecken", "Cyrus", "Deacon", "Ellis", "Ford", "Gage", "Harlan", "Jett", "Kip", "Linus", "Moss", "Nolan", "Orrin"];
const LAST = ["Abernathy", "Brightwater", "Calloway", "Delacorte", "Eastwick", "Fairbanks", "Galloway", "Hartigan", "Ironwood", "Jessup", "Kettering", "Larkspur", "Merriweather", "Northcutt", "Oakhurst", "Pennington", "Quarles", "Rutherford", "Stanwick", "Thistlewood", "Underhill", "Vandermeer", "Whitlock", "Yardley", "Ashcombe", "Blackwell", "Cranford", "Dunmore", "Elsworth", "Fenwick", "Glasscock", "Hollister", "Kingsley", "Lockhart", "Marlowe", "Nettleton", "Ormsby", "Prescott", "Radcliffe", "Sherwood", "Tolliver", "Wexford"];
const used = new Set();
function name() { for (;;) { const n = [pick(FIRST), pick(LAST)]; const k = n.join(" "); if (!used.has(k)) { used.add(k); return n; } } }

// Ridgeline's hitters (the demo roster in scripts/_seed.js), each with a profile so their pages differ:
// contact, power, eye (lays off balls), aggr (swings at strikes), lift (fly ball vs ground ball), and a 2025 version.
const RIDGELINE = {
  Avery: { contact: 0.86, power: 0.32, eye: 0.82, aggr: 0.45, lift: 0.2, y2025: { power: 0.22, eye: 0.74 } },
  Kowalczyk: { contact: 0.6, power: 0.7, eye: 0.38, aggr: 0.75, lift: 0.6, y2025: { eye: 0.26, contact: 0.55 } },
  "Ibarra-Stone": { contact: 0.78, power: 0.42, eye: 0.62, aggr: 0.5, lift: 0.1 },
  Whitacre: { contact: 0.52, power: 0.85, eye: 0.5, aggr: 0.6, lift: 0.75, y2025: { power: 0.7 } },
  "Okafor-Price": { contact: 0.66, power: 0.5, eye: 0.3, aggr: 0.7, lift: 0.3, fresh: true },
  Lindqvist: { contact: 0.72, power: 0.68, eye: 0.72, aggr: 0.55, lift: 0.5, transfer: "demo-marrow" },
  Varela: { contact: 0.72, power: 0.35, eye: 0.55, aggr: 0.5, lift: -0.5 },
  Pemberton: { contact: 0.6, power: 0.55, eye: 0.45, aggr: 0.6, lift: 0.2, y2025: { contact: 0.66 } },
  Marchetti: { contact: 0.66, power: 0.78, eye: 0.66, aggr: 0.5, lift: 0.55 },
  Thornbury: { contact: 0.52, power: 0.3, eye: 0.5, aggr: 0.5, lift: 0, bench: true, fresh: true },
  "Nakashima-Ruiz": { contact: 0.82, power: 0.18, eye: 0.6, aggr: 0.45, lift: -0.6, bench: true },
  Fairweather: { contact: 0.55, power: 0.45, eye: 0.42, aggr: 0.6, lift: 0.1, bench: true, fresh: true },
};

function makeHitter(first, last, bats, base) {
  return { first, last, bats, key: nameKey(last, first), ...base };
}
function randomHitter() {
  const [f, l] = name();
  return makeHitter(f, l, pickW([{ v: "R", w: 6 }, { v: "L", w: 3.5 }, { v: "S", w: 0.5 }]).v,
    { contact: clamp(normal(0.66, 0.1), 0.4, 0.9), power: clamp(normal(0.5, 0.17), 0.1, 0.9), eye: clamp(normal(0.55, 0.15), 0.2, 0.9), aggr: clamp(normal(0.55, 0.12), 0.3, 0.85), lift: clamp(normal(0.1, 0.4), -0.8, 0.8) });
}
const ARSENALS = [
  ["Fastball", "Slider", "Changeup"], ["Fastball", "Curveball", "Changeup"], ["Sinker", "Slider", "Changeup"], ["Fastball", "Slider", "Curveball", "Changeup"],
  ["Fastball", "Cutter", "Curveball"], ["Fastball", "Sweeper", "Changeup"], ["Sinker", "Sweeper", "Splitter"], ["Fastball", "Slider", "Splitter"],
];
function makePitcher(role) {
  const [f, l] = name(), throws = rand() < 0.3 ? "L" : "R";
  const fb = clamp(normal(role === "SP" ? 89.5 : 90.5, 2.2), 84, 97);
  const types = pick(ARSENALS);
  const arsenal = types.map((t, i) => {
    const fast = /Fastball|Sinker|Cutter/.test(t);
    const velo = t === "Fastball" ? fb : t === "Sinker" ? fb - 0.8 : t === "Cutter" ? fb - 4 : t === "Changeup" || t === "Splitter" ? fb - 8 : t === "Curveball" ? fb - 13 : fb - 10;
    const spin = t === "Fastball" ? normal(2250, 120) : t === "Sinker" ? normal(2100, 100) : t === "Curveball" ? normal(2450, 150) : /Slider|Sweeper|Cutter/.test(t) ? normal(2400, 150) : normal(1750, 120);
    return { type: t, velo, spin: Math.round(spin), w: i === 0 ? 0.55 : fast ? 0.25 : 0.2, stuff: clamp(normal(fast ? 1 : 1.15, 0.12), 0.8, 1.5), breaking: !fast };
  });
  return { first: f, last: l, key: nameKey(l, f), throws, role, arsenal, command: clamp(normal(0.47, 0.05), 0.38, 0.58) };
}

/* ---------- one plate appearance, pitch by pitch ---------- */
const ZONE_X = 0.83, ZONE_LO = 1.5, ZONE_HI = 3.5;
function choosePitch(p, balls, strikes) {
  return pickW(p.arsenal.map((a) => ({ ...a, w: a.w * (a.breaking ? (strikes === 2 ? 1.5 : balls > strikes ? 0.6 : 1) : (balls > strikes ? 1.4 : 1)) })));
}
function locate(p, a, balls, strikes, bats) {
  const zoneP = clamp(p.command + (balls === 3 ? 0.15 : 0) - (strikes === 2 && balls < 3 ? 0.1 : 0) - (a.breaking ? 0.05 : 0), 0.25, 0.8);
  // "away" from the hitter in catcher's-view x: right-handed hitters stand on the left (negative x side is inside)
  const away = bats === "L" ? -1 : 1;
  if (rand() < zoneP) return { x: clamp(normal(a.breaking ? away * 0.25 : 0, 0.42), -0.83, 0.83), z: clamp(normal(a.breaking ? 2.2 : 2.65, 0.45), 1.5, 3.5) };
  if (a.breaking && rand() < 0.65) return { x: normal(away * 0.6, 0.45), z: normal(1.05, 0.3) };   // down, and away more often
  const side = rand() < 0.5;
  return side ? { x: (rand() < 0.5 ? -1 : 1) * normal(1.15, 0.2), z: normal(2.5, 0.6) } : { x: normal(0, 0.55), z: rand() < 0.55 ? normal(1.1, 0.25) : normal(3.9, 0.25) };
}
const inZone = (l) => Math.abs(l.x) <= ZONE_X && l.z >= ZONE_LO && l.z <= ZONE_HI;
const nearEdge = (l) => Math.abs(Math.abs(l.x) - ZONE_X) < 0.12 || Math.abs(l.z - ZONE_LO) < 0.12 || Math.abs(l.z - ZONE_HI) < 0.12;

function plateAppearance(p, h) {
  const bats = h.bats === "S" ? (p.throws === "R" ? "L" : "R") : h.bats;
  let balls = 0, strikes = 0, seq = "";
  const pitches = [];
  for (let n = 1; n <= 15; n++) {
    const a = choosePitch(p, balls, strikes), loc = locate(p, a, balls, strikes, bats), z = inZone(loc);
    const velo = Math.round(normal(a.velo, 0.9) * 10) / 10, spin = Math.round(normal(a.spin, 60));
    const before = { balls, strikes };
    const rec = { type: a.type, velo, spin, x: Math.round(loc.x * 100) / 100, z: Math.round(loc.z * 100) / 100, ...before };
    // hit by pitch: some balls well inside
    if (!z && rand() < 0.012) { pitches.push({ ...rec, call: "hbp" }); seq += "B"; return finish("HBP"); }
    const heart = Math.abs(loc.x) < 0.5 && loc.z > 1.9 && loc.z < 3.1;
    const swingP = z ? clamp(0.5 + h.aggr * 0.3 + (heart ? 0.1 : 0) + (strikes === 2 ? 0.18 : 0) - (balls === 3 && strikes < 2 ? 0.2 : 0), 0.2, 0.97)
      : clamp((0.08 + (1 - h.eye) * 0.34) * (a.breaking ? 1.2 : 1) + (strikes === 2 ? 0.12 : 0) - (Math.abs(loc.x) > 1.3 || loc.z < 0.8 || loc.z > 4.2 ? 0.15 : 0), 0.02, 0.8);
    if (rand() < swingP) {
      const contactP = clamp((0.2 + 0.92 * h.contact) * (z ? (heart ? 1.04 : 0.96) : 0.68) * (strikes === 2 ? 0.95 : 1) / Math.pow(a.stuff, 0.9), 0.2, 0.98);
      if (rand() > contactP) { pitches.push({ ...rec, call: "swinging_strike" }); seq += "S"; strikes++; if (strikes === 3) return finish("KS"); continue; }
      if (rand() < (strikes === 2 ? 0.4 : 0.36)) { pitches.push({ ...rec, call: "foul" }); seq += "F"; if (strikes < 2) strikes++; continue; }
      // ball in play
      const ev = clamp(normal(79 + h.power * 20 + (heart ? 4 : z ? 0 : -7) - (a.breaking ? 2 : 0), 9), 35, 116);
      const la = clamp(normal(9 + h.lift * 10 + (loc.z > 2.9 ? 6 : loc.z < 2 ? -6 : 0), 22), -55, 75);
      const pull = bats === "R" ? -1 : 1;
      const bearing = clamp(normal(pull * (8 + h.power * 10), 21), -45, 45);
      const rad = (la * Math.PI) / 180, vs = ev * 1.467;
      const dist = Math.round(la < 6 ? clamp(ev * 1.4 + normal(0, 18), 20, 170) : clamp((vs * vs * Math.sin(2 * rad) / 32.2) * 0.58 + normal(0, 15), 30, 470));
      const fence = 325 + 70 * (1 - Math.abs(bearing) / 45);
      const bb = la < 10 ? "GB" : la < 25 ? "LD" : la < 50 ? "FB" : "PU";
      let out;
      if (bb === "FB" && dist >= fence) out = "HR";
      else {
        const hitP = bb === "GB" ? 0.19 + Math.max(0, ev - 88) * 0.011 : bb === "LD" ? 0.6 + Math.max(0, ev - 92) * 0.008 : bb === "FB" ? 0.07 + Math.max(0, dist - 290) * 0.0035 : 0.02;
        if (rand() < hitP) out = bb === "GB" ? (rand() < 0.08 ? "2B" : "1B") : dist > 300 && rand() < 0.08 ? "3B" : dist > 240 && rand() < 0.42 ? "2B" : "1B";
        else out = bb === "GB" ? "GO" : bb === "LD" ? "LO" : bb === "FB" ? "FO" : rand() < 0.15 ? "FFO" : "PO";
      }
      pitches.push({ ...rec, call: "in_play", ev: Math.round(ev * 10) / 10, la: Math.round(la * 10) / 10, bearing: Math.round(bearing * 10) / 10, dist, bb });
      return finish(out, { bb, bearing });
    }
    // take
    const strikeP = z ? (nearEdge(loc) ? 0.84 : 0.98) : nearEdge(loc) ? 0.1 : 0.01;
    if (rand() < strikeP) { pitches.push({ ...rec, call: "called_strike" }); seq += "K"; strikes++; if (strikes === 3) return finish("KL"); }
    else { pitches.push({ ...rec, call: "ball" }); seq += "B"; balls++; if (balls === 4) return finish("BB"); }
  }
  return finish("GO", { bb: "GB", bearing: 0 });
  function finish(outcome, extra = {}) {
    const last = pitches[pitches.length - 1];
    return { outcome, seq, balls: last.balls, strikes: last.strikes, pitches, bats, bb: extra.bb || null, field: extra.bearing == null ? null : extra.bearing < -15 ? "L" : extra.bearing > 15 ? "R" : "C" };
  }
}

/* ---------- a game ---------- */
const HITS = new Set(["1B", "2B", "3B", "HR"]);
function simGame(g, teams) {
  const home = teams[g.home], away = teams[g.away];
  const lineup = (t) => {
    const pool = t.hitters.filter((h) => h.seasons.includes(g.season));
    const regulars = pool.filter((h) => !h.bench), bench = pool.filter((h) => h.bench);
    const nine = regulars.slice();
    while (nine.length > 9) nine.splice(Math.floor(rand() * nine.length), 1);
    for (let i = 0; i < nine.length && bench.length; i++) if (rand() < 0.12) nine[i] = bench.splice(Math.floor(rand() * bench.length), 1)[0];
    return nine.slice(0, 9);
  };
  const starter = (t) => (g.dow === 5 ? t.sp[0] : g.dow === 6 ? t.sp[1] : g.dow === 0 ? t.sp[2] : t.mid);
  const side = { [g.away]: { lineup: lineup(away), next: 0, runs: 0 }, [g.home]: { lineup: lineup(home), next: 0, runs: 0 } };
  const staff = { [g.home]: { cur: starter(home), used: [], pool: home.rp.slice().sort(() => rand() - 0.5) }, [g.away]: { cur: starter(away), used: [], pool: away.rp.slice().sort(() => rand() - 0.5) } };
  const lines = new Map(), pas = [], pitchRows = [];
  const line = (seo, p, started) => { const k = seo + "|" + p.key; if (!lines.has(k)) lines.set(k, { seo, p, started, bf: 0, outs: 0, h: 0, bb: 0, k: 0, hbp: 0, hr: 0, pitches: 0, runs: 0 }); return lines.get(k); };
  line(g.home, staff[g.home].cur, true); line(g.away, staff[g.away].cur, true);
  for (let inning = 1; inning <= 12; inning++) {
    for (const top of [true, false]) {
      const bat = top ? g.away : g.home, fld = top ? g.home : g.away;
      if (!top && inning >= 9 && side[g.home].runs > side[g.away].runs) break;
      let outs = 0, bases = [false, false, false];
      while (outs < 3) {
        const S = staff[fld];
        let L = line(fld, S.cur, false);
        const limit = S.cur.role === "SP" ? 88 + rand() * 15 : 22 + rand() * 12;
        if ((L.pitches > limit || L.runs >= 5) && S.pool.length) { S.cur = S.pool.shift(); L = line(fld, S.cur, false); }
        const h = side[bat].lineup[side[bat].next++ % side[bat].lineup.length];
        const r = plateAppearance(S.cur, h);
        let outcome = r.outcome, runs = 0;
        const score = (n) => { runs += n; };
        if (outcome === "KS" || outcome === "KL" || outcome === "LO" || outcome === "PO" || outcome === "FFO") outs++;
        else if (outcome === "GO") { if (bases[0] && outs < 2 && rand() < 0.35) { outcome = "GDP"; outs += 2; bases[0] = false; } else { outs++; if (outs < 3) { if (bases[2] && rand() < 0.5) { score(1); bases[2] = false; } if (bases[1]) { bases[2] = true; bases[1] = false; } } } }
        else if (outcome === "FO") { if (bases[2] && outs < 2 && rand() < 0.55) { outcome = "SF"; score(1); bases[2] = false; } outs++; }
        else if (outcome === "BB" || outcome === "HBP") { if (bases[0] && bases[1] && bases[2]) score(1); else if (bases[0] && bases[1]) bases[2] = true; else if (bases[0]) bases[1] = true; bases[0] = true; }
        else if (outcome === "1B") { let b2 = false, b3 = false; if (bases[2]) score(1); if (bases[1]) { if (rand() < 0.7) score(1); else b3 = true; } if (bases[0]) { if (!b3 && rand() < 0.3) b3 = true; else b2 = true; } bases = [true, b2, b3]; }
        else if (outcome === "2B") { const n = (bases[2] ? 1 : 0) + (bases[1] ? 1 : 0); score(n); const third = bases[0] && rand() > 0.4; if (bases[0] && !third) score(1); bases = [false, true, third]; }
        else if (outcome === "3B") { score(bases.filter(Boolean).length); bases = [false, false, true]; }
        else if (outcome === "HR") { score(bases.filter(Boolean).length + 1); bases = [false, false, false]; }
        side[bat].runs += runs; L.runs += runs;
        const idx = pas.length, ref = `${g.id}:${inning}${top ? "t" : "b"}:${idx}`;
        const outs1 = { KL: 1, KS: 1, GO: 1, FO: 1, LO: 1, PO: 1, FFO: 1, SF: 1, GDP: 2 }[outcome] || 0;
        L.bf++; L.pitches += r.pitches.length; L.outs += outs1; if (HITS.has(outcome)) L.h++; if (outcome === "BB") L.bb++; if (/^K/.test(outcome)) L.k++; if (outcome === "HBP") L.hbp++; if (outcome === "HR") L.hr++;
        const inPlay = !/^(KL|KS|BB|HBP)$/.test(outcome);
        pas.push({ idx, inning, bat, fld, h, p: S.cur, outcome, r, inPlay, ref });
        r.pitches.forEach((x, i) => pitchRows.push({ ...x, n: i + 1, idx, inning, bat, fld, h, p: S.cur, bats: r.bats, last: i === r.pitches.length - 1, outcome, ref }));
        if (!top && inning >= 9 && side[g.home].runs > side[g.away].runs) break;
      }
    }
    if (inning >= 9 && side[g.home].runs !== side[g.away].runs) break;
  }
  return { pas, pitchRows, lines: [...lines.values()], homeRuns: side[g.home].runs, awayRuns: side[g.away].runs };
}

/* ---------- schedule ---------- */
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function firstFriday(y) { let d = `${y}-02-13`; while (new Date(d + "T12:00:00Z").getUTCDay() !== 5) d = addDays(d, 1); return d; }
function schedule(y, weekends = 13, tuesdays = 12) {
  const seos = DEMO_LEAGUE.map((t) => t.seo), games = [];
  // round robin (circle method) for weekend series
  const rot = seos.slice(1), rounds = [];
  for (let r = 0; r < 5; r++) { const order = [seos[0], ...rot]; const pairs = []; for (let i = 0; i < 3; i++) pairs.push([order[i], order[5 - i]]); rounds.push(pairs); rot.unshift(rot.pop()); }
  const fri = firstFriday(y);
  for (let w = 0; w < weekends; w++) {
    const pairs = rounds[w % 5], flip = Math.floor(w / 5) % 2 === 1;
    for (const [a, b] of pairs) for (const off of [0, 1, 2]) {
      const date = addDays(fri, w * 7 + off), [home, away] = flip ? [b, a] : [a, b];
      games.push({ date, home, away, dow: [5, 6, 0][off] });
    }
  }
  for (let w = 0; w < tuesdays; w++) {
    const date = addDays(fri, w * 7 + 4), s = seos.slice().sort(() => rand() - 0.5);
    for (let i = 0; i < 6; i += 2) games.push({ date, home: s[i], away: s[i + 1], dow: 2 });
  }
  return games.sort((a, b) => a.date.localeCompare(b.date) || a.home.localeCompare(b.home)).map((g, i) => ({ ...g, season: y, id: `demo-${y}-${String(i + 1).padStart(3, "0")}` }));
}

/* ---------- build and save ---------- */
export async function buildDemoSeasons({ roster, force = false, log = () => {} } = {}) {
  const have = await query(`SELECT v FROM kv WHERE k = 'demo_season'`);
  if (!force && have[0] && have[0].v.version === DEMO_SEASON_VERSION) return { skipped: true };
  R = rng(20260413); used.clear();
  for (const t of ["pitches", "ncaa_pas", "ncaa_pitch_lines", "ncaa_game_data"]) await query(`DELETE FROM ${t} WHERE game_id LIKE 'demo-%'`);
  await query(`DELETE FROM ncaa_games WHERE id LIKE 'demo-%'`);

  // teams: Ridgeline uses the demo roster's names; everyone else is generated
  const teams = {};
  for (const t of DEMO_LEAGUE) teams[t.seo] = { ...t, hitters: [], sp: [], mid: null, rp: [] };
  for (const [first, last, bats, cls] of roster) {
    const prof = RIDGELINE[last] || { contact: 0.65, power: 0.5, eye: 0.55, aggr: 0.55, lift: 0.1 };
    const h = makeHitter(first, last, bats, prof);
    h.seasons = prof.fresh || /^Fr|RS Fr/.test(cls) ? [2026] : [2025, 2026];
    if (prof.transfer) { h.seasons = [2026]; const old = { ...h, ...prof, seasons: [2025] }; teams[prof.transfer].hitters.push(old); }
    if (prof.y2025) { const old = { ...h, ...prof.y2025, seasons: [2025] }; h.seasons = [2026]; teams["demo-ridgeline"].hitters.push(old); }
    teams["demo-ridgeline"].hitters.push(h);
  }
  for (const t of Object.values(teams)) {
    while (t.hitters.filter((h) => h.seasons.includes(2026)).length < 11) { const h = randomHitter(); h.seasons = [2025, 2026]; t.hitters.push(h); }
    while (t.hitters.filter((h) => h.seasons.includes(2025)).length < 11) { const h = randomHitter(); h.seasons = [2025]; t.hitters.push(h); }
    t.sp = [makePitcher("SP"), makePitcher("SP"), makePitcher("SP")]; t.mid = makePitcher("SP");
    t.rp = Array.from({ length: 7 }, () => makePitcher("RP"));
  }
  const nameOf = Object.fromEntries(DEMO_LEAGUE.map((t) => [t.seo, t.name]));
  let nGames = 0, nPitches = 0;
  for (const y of SEASONS) {
    for (const g of schedule(y)) {
      const s = simGame(g, teams);
      await query(`INSERT INTO ncaa_games (id, date, season, epoch, state, time, home_seo, home_name, home_score, away_seo, away_name, away_score) VALUES ($1,$2,$3,$4,'final',$5,$6,$7,$8,$9,$10,$11)`,
        [g.id, g.date, y, Math.floor(Date.parse(g.date + "T23:00:00Z") / 1000), g.dow === 2 ? "6:00 PM" : g.dow === 0 ? "1:00 PM" : "6:30 PM", g.home, nameOf[g.home], s.homeRuns, g.away, nameOf[g.away], s.awayRuns]);
      await query(`INSERT INTO ncaa_game_data (game_id, box, pbp, parser_v) VALUES ($1, '{"demo":true}'::jsonb, '{"demo":true}'::jsonb, 9999)`, [g.id]);
      await rows("ncaa_pas", ["game_id", "idx", "inning", "bat_seo", "pitch_seo", "batter_key", "batter", "pitcher", "pitcher_name", "outcome", "seq", "balls", "strikes", "pitches", "swings", "whiffs", "fouls", "called", "in_play", "hit", "ab", "bb", "field", "text"],
        s.pas.map((a) => { const r = a.r, seq = r.seq, inPlay = a.inPlay;
          const whiffs = [...seq].filter((c) => c === "S").length, fouls = [...seq].filter((c) => c === "F").length, called = [...seq].filter((c) => c === "K").length;
          return [g.id, a.idx, a.inning, a.bat, a.fld, a.h.key, `${a.h.first} ${a.h.last}`, a.p.key, `${a.p.first} ${a.p.last}`, a.outcome, seq, r.balls, r.strikes,
            r.pitches.length, whiffs + fouls + (inPlay ? 1 : 0), whiffs, fouls, called, inPlay, HITS.has(a.outcome), !/^(BB|HBP|SF)$/.test(a.outcome), r.bb, r.field,
            `${a.h.last}, ${a.h.first} ${TEXT[a.outcome] || "made an out"}${r.field ? " to " + { L: "left", C: "center", R: "right" }[r.field] : ""} (${r.balls}-${r.strikes}${seq ? " " + seq : ""}).`]; }));
      await rows("ncaa_pitch_lines", ["game_id", "seo", "name", "display", "started", "bf", "outs", "h", "bb", "k", "hbp", "hr", "pitches"],
        s.lines.map((L) => [g.id, L.seo, L.p.key, `${L.p.first} ${L.p.last}`, L.started, L.bf, L.outs, L.h, L.bb, L.k, L.hbp, L.hr, L.pitches]));
      await rows("pitches", ["id", "game_id", "pa_idx", "pitch_no", "date", "season", "inning", "bat_seo", "pitch_seo", "batter_key", "pitcher_key", "batter_side", "pitcher_throws",
        "balls", "strikes", "pitch_type", "velo", "spin", "plate_x", "plate_z", "call", "ev", "la", "bearing", "distance", "result", "source", "pa_ref", "hit_type", "batter_name", "pitcher_name"],
        s.pitchRows.map((x, i) => [`${g.id}-${i + 1}`, g.id, x.idx, x.n, g.date, y, x.inning, x.bat, x.fld, x.h.key, x.p.key, x.bats, x.p.throws, x.balls, x.strikes, x.type, x.velo, x.spin, x.x, x.z, x.call,
          x.ev ?? null, x.la ?? null, x.bearing ?? null, x.dist ?? null, x.last ? x.outcome : null, "demo", x.ref, x.bb ?? null, `${x.h.first} ${x.h.last}`, `${x.p.first} ${x.p.last}`]));
      nGames++; nPitches += s.pitchRows.length;
      if (nGames % 40 === 0) log(`  ${nGames} games, ${nPitches} pitches`);
    }
  }
  // next season's schedule, posted: Ridgeline's first three weekends and two Tuesdays
  for (const g of schedule(2027, 3, 2).filter((g) => g.home === "demo-ridgeline" || g.away === "demo-ridgeline")) {
    await query(`INSERT INTO ncaa_games (id, date, season, epoch, state, time, home_seo, home_name, away_seo, away_name) VALUES ($1,$2,2027,$3,'pre',$4,$5,$6,$7,$8)`,
      [g.id, g.date, Math.floor(Date.parse(g.date + "T23:00:00Z") / 1000), g.dow === 2 ? "6:00 PM" : "6:30 PM", g.home, nameOf[g.home], g.away, nameOf[g.away]]);
  }
  await query(`INSERT INTO kv (k, v, updated_at) VALUES ('demo_season', $1::jsonb, now()) ON CONFLICT (k) DO UPDATE SET v = $1::jsonb, updated_at = now()`, [JSON.stringify({ version: DEMO_SEASON_VERSION, games: nGames, pitches: nPitches })]);
  return { games: nGames, pitches: nPitches };
}
const TEXT = { KL: "struck out looking", KS: "struck out swinging", BB: "walked", HBP: "hit by pitch", "1B": "singled", "2B": "doubled", "3B": "tripled", HR: "homered",
  GO: "grounded out", GDP: "grounded into double play", FO: "flied out", SF: "sacrifice fly", LO: "lined out", PO: "popped up", FFO: "fouled out" };
async function rows(table, cols, data) {
  for (let s = 0; s < data.length; s += 120) {
    const chunk = data.slice(s, s + 120), params = [];
    const values = chunk.map((r) => "(" + r.map((v) => { params.push(v); return "$" + params.length; }).join(",") + ")").join(",");
    await query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values} ON CONFLICT DO NOTHING`, params);
  }
}
