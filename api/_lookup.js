import { query, one } from "./_db.js";
import { activeSeasons, today } from "./_sync.js";
import { aliases, nameQuality, display } from "./_opponent.js";
import { gradeAtBat, gradeGame, zoneOf, spot } from "./_grade.js";
import { line } from "./_gamelog.js";

// Look up any team in the data: its hitters and pitchers, its game log, and any one player's game log with
// his at-bats (or, for a pitcher, the batters he faced). Grades for other teams' hitters come from the app's
// rules; Claude grades only our own players' games.

const ip = (outs) => Math.floor(outs / 3) + (outs % 3) / 10;
const best = (names) => names.filter(Boolean).sort((a, b) => nameQuality(b) - nameQuality(a))[0] || null;

/** Every team with games in the seasons we keep, ours first. */
export async function teams(team) {
  const rows = await query(`SELECT seo, max(name) AS name, count(*)::int AS games FROM (
      SELECT home_seo AS seo, home_name AS name FROM ncaa_games WHERE season = ANY($1::int[]) AND state = 'final'
      UNION ALL SELECT away_seo, away_name FROM ncaa_games WHERE season = ANY($1::int[]) AND state = 'final') x
    WHERE seo NOT IN ('tba', '') AND name !~* '^tba$' GROUP BY seo ORDER BY max(name)`, [activeSeasons(team)]);
  const ours = rows.find((r) => r.seo === team.ncaa_seo);
  return [{ seo: team.ncaa_seo, name: team.name, games: ours ? ours.games : 0, ours: true }, ...rows.filter((r) => r.seo !== team.ncaa_seo)];
}

const seasonsOf = async (seo) => (await query(`SELECT DISTINCT season FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND state = 'final' AND date < $2 ORDER BY 1 DESC`, [seo, today()])).map((r) => r.season);
const teamName = (g, seo) => (g ? (g.home_seo === seo ? g.home_name : g.away_name) : seo);

/** A team's hitters and pitchers for a season (its latest by default). */
export async function teamRoster(seo, season) {
  const seasons = await seasonsOf(seo);
  season = seasons.includes(season) ? season : seasons[0];
  if (!season) return { seo, seasons, season: null, hitters: [], pitchers: [] };
  const g = await one(`SELECT home_seo, home_name, away_name FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND season = $2 LIMIT 1`, [seo, season]);
  const pas = await query(`SELECT pa.batter_key AS k, pa.batter AS d, count(*)::int AS pa, count(*) FILTER (WHERE pa.ab)::int AS ab, count(*) FILTER (WHERE pa.hit)::int AS h,
      count(*) FILTER (WHERE pa.outcome = 'HR')::int AS hr FROM ncaa_pas pa JOIN ncaa_games g ON g.id = pa.game_id
    WHERE pa.bat_seo = $1 AND g.season = $2 AND pa.batter_key IS NOT NULL GROUP BY 1, 2`, [seo, season]);
  const hal = aliases(pas.map((r) => r.k)), H = new Map();
  for (const r of pas) { const k = hal[r.k] || r.k, x = H.get(k) || { key: k, names: [], pa: 0, ab: 0, h: 0, hr: 0 }; x.names.push(r.d); x.pa += r.pa; x.ab += r.ab; x.h += r.h; x.hr += r.hr; H.set(k, x); }
  const lines = await query(`SELECT l.name AS k, l.display AS d, count(*)::int AS apps, count(*) FILTER (WHERE l.started)::int AS gs, sum(l.outs)::int AS outs, sum(l.k)::int AS k2, sum(l.bf)::int AS bf
    FROM ncaa_pitch_lines l JOIN ncaa_games g ON g.id = l.game_id WHERE l.seo = $1 AND g.season = $2 GROUP BY 1, 2`, [seo, season]);
  const pal = aliases(lines.map((r) => r.k)), P = new Map();
  for (const r of lines) { const k = pal[r.k] || r.k, x = P.get(k) || { key: k, names: [], apps: 0, starts: 0, outs: 0, k: 0, bf: 0 }; x.names.push(r.d); x.apps += r.apps; x.starts += r.gs; x.outs += r.outs; x.k += r.k2; x.bf += r.bf; P.set(k, x); }
  const nm = (x) => { const b = best(x.names); return nameQuality(b) >= 2 ? b : display(x.key); };
  return {
    seo, name: teamName(g, seo), seasons, season,
    hitters: [...H.values()].map((x) => ({ key: x.key, name: nm(x), pa: x.pa, ab: x.ab, h: x.h, hr: x.hr })).sort((a, b) => b.pa - a.pa),
    pitchers: [...P.values()].map((x) => ({ key: x.key, name: nm(x), apps: x.apps, starts: x.starts, ip: ip(x.outs), k: x.k, bf: x.bf })).sort((a, b) => b.ip - a.ip || b.apps - a.apps),
  };
}

/** All spellings of one player on a team ("smith|" folds into "smith|j" when he's the only Smith). */
export async function keysFor(seo, key, side) {
  const col = side === "pitch" ? `SELECT DISTINCT name AS k FROM ncaa_pitch_lines WHERE seo = $1 AND name LIKE $2` : `SELECT DISTINCT batter_key AS k FROM ncaa_pas WHERE bat_seo = $1 AND batter_key LIKE $2`;
  const ks = (await query(col, [seo, key.split("|")[0] + "|%"])).map((r) => r.k);
  const al = aliases([...ks, key]), main = al[key] || key;
  return [...new Set([main, ...Object.keys(al).filter((k) => al[k] === main)])];
}

const gameRow = (g, seo) => { const home = g.home_seo === seo; return { id: g.id, date: g.date, season: g.season, opponent: home ? g.away_name : g.home_name, home, us: home ? g.home_score : g.away_score, them: home ? g.away_score : g.home_score }; };

/** A team's game log with its team line each game, or one game's box: every hitter's line and every pitcher's. */
export async function teamGames(seo, season, gameId) {
  if (gameId) {
    const g = await one(`SELECT * FROM ncaa_games WHERE id = $1 AND (home_seo = $2 OR away_seo = $2)`, [gameId, seo]);
    if (!g) return { notFound: true };
    const pas = await query(`SELECT * FROM ncaa_pas WHERE game_id = $1 AND bat_seo = $2 ORDER BY idx`, [gameId, seo]);
    const hal = aliases(pas.map((r) => r.batter_key)), by = new Map();
    for (const r of pas) { const k = hal[r.batter_key] || r.batter_key; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
    const pl = await query(`SELECT * FROM ncaa_pitch_lines WHERE game_id = $1 AND seo = $2`, [gameId, seo]);
    return { game: { ...gameRow(g, seo), team: teamName(g, seo), line: line(pas) },
      hitters: [...by.entries()].map(([key, xs]) => ({ key, name: nameQuality(best(xs.map((x) => x.batter))) >= 2 ? best(xs.map((x) => x.batter)) : display(key), line: line(xs) })),
      pitchers: pl.map((l) => ({ key: l.name, name: nameQuality(l.display) >= 2 ? l.display : display(l.name), started: l.started, ip: ip(l.outs), h: l.h, bb: l.bb, k: l.k, hr: l.hr, pitches: l.pitches })).sort((a, b) => (b.started ? 1 : 0) - (a.started ? 1 : 0)) };
  }
  const games = await query(`SELECT * FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND state = 'final' AND season = $2 AND date < $3 ORDER BY date DESC`, [seo, season, today()]);
  const pas = games.length ? await query(`SELECT game_id, ab, hit, outcome FROM ncaa_pas WHERE bat_seo = $1 AND game_id = ANY($2::text[])`, [seo, games.map((g) => g.id)]) : [];
  return { games: games.map((g) => ({ ...gameRow(g, seo), line: line(pas.filter((p) => p.game_id === g.id)) })).filter((g) => g.line.pa) };
}

/** Any hitter's game log, or one game with his at-bats graded by the app's rules. */
export async function hitterLog(seo, key, season, gameId) {
  const keys = await keysFor(seo, key, "bat");
  const rows = await query(`SELECT pa.*, g.date, g.season, g.home_seo, g.away_seo, g.home_name, g.away_name, g.home_score, g.away_score
    FROM ncaa_pas pa JOIN ncaa_games g ON g.id = pa.game_id WHERE pa.bat_seo = $1 AND pa.batter_key = ANY($2::text[]) AND ${gameId ? "pa.game_id = $3" : "g.season = $3"} ORDER BY g.date DESC, pa.idx`,
    [seo, keys, gameId || season]);
  const name = best(rows.map((r) => r.batter));
  const who = { key: keys[0], name: nameQuality(name) >= 2 ? name : display(keys[0]) };
  const ids = [...new Set(rows.map((r) => r.game_id))];
  const pitches = ids.length ? await query(`SELECT * FROM pitches WHERE game_id = ANY($1::text[]) AND batter_key = ANY($2::text[]) AND bat_seo = $3 ORDER BY game_id, pa_idx, pitch_no`, [ids, keys, seo]) : [];
  const byPa = new Map(); for (const x of pitches) { const k = x.game_id + "|" + x.pa_idx; if (!byPa.has(k)) byPa.set(k, []); byPa.get(k).push(x); }
  const sides = new Set(pitches.map((x) => x.batter_side).filter(Boolean)), bats = sides.size > 1 ? "S" : [...sides][0] || "R";
  const side = (x) => (bats === "S" ? (x && x.pitcher_throws === "R" ? "L" : "R") : bats);
  const atBat = (r) => { const ps = byPa.get(r.game_id + "|" + r.idx) || []; return { r, ps, g: gradeAtBat(r, ps, side(ps[0])) }; };
  if (!gameId) return { who, bats, games: ids.map((id) => { const xs = rows.filter((r) => r.game_id === id); return { ...gameRow({ ...xs[0], id }, seo), line: line(xs) }; }) };
  const ab = rows.map(atBat);
  if (!ab.length) return { notFound: true };
  return { who, bats, game: { ...gameRow({ ...rows[0], id: gameId }, seo), line: line(rows) }, gameGrade: gradeGame(ab.map((a) => a.g)).grade, rulesOnly: true,
    atBats: ab.map(({ r, ps, g }, i) => ({ n: i + 1, inning: r.inning, pitcher: r.pitcher_name || display(r.pitcher), outcome: r.outcome, seq: r.seq, grade: g.grade, summary: null,
      pitches: ps.map((x) => ({ no: x.pitch_no, balls: x.balls, strikes: x.strikes, type: x.pitch_type, velo: x.velo, call: x.call, x: x.plate_x, z: x.plate_z, zone: zoneOf(x.plate_x, x.plate_z), spot: spot(x.plate_x, x.plate_z, side(x)), ev: x.ev, la: x.la, distance: x.distance, video: x.video_url, throws: x.pitcher_throws })) })) };
}

/** Any pitcher's game log (every outing), or one outing: each batter he faced, pitch by pitch. */
export async function pitcherLog(seo, key, season, gameId) {
  const keys = await keysFor(seo, key, "pitch");
  if (!gameId) {
    const outs = await query(`SELECT l.*, g.id, g.date, g.season, g.home_seo, g.home_name, g.away_name, g.home_score, g.away_score FROM ncaa_pitch_lines l JOIN ncaa_games g ON g.id = l.game_id
      WHERE l.seo = $1 AND l.name = ANY($2::text[]) AND g.season = $3 ORDER BY g.date DESC`, [seo, keys, season]);
    return { games: outs.map((o) => ({ ...gameRow(o, seo), started: o.started, ip: ip(o.outs), bf: o.bf, h: o.h, bb: o.bb, k: o.k, hr: o.hr, pitches: o.pitches })) };
  }
  const g = await one(`SELECT * FROM ncaa_games WHERE id = $1`, [gameId]);
  const l = await one(`SELECT * FROM ncaa_pitch_lines WHERE game_id = $1 AND seo = $2 AND name = ANY($3::text[])`, [gameId, seo, keys]);
  if (!g || !l) return { notFound: true };
  const pas = await query(`SELECT * FROM ncaa_pas WHERE game_id = $1 AND pitch_seo = $2 AND pitcher = ANY($3::text[]) ORDER BY idx`, [gameId, seo, keys]);
  const ps = await query(`SELECT * FROM pitches WHERE game_id = $1 AND pitch_seo = $2 AND pitcher_key = ANY($3::text[]) ORDER BY pa_idx, pitch_no`, [gameId, seo, keys]);
  return { name: nameQuality(l.display) >= 2 ? l.display : display(l.name), game: { ...gameRow(g, seo), started: l.started, ip: ip(l.outs), bf: l.bf, h: l.h, bb: l.bb, k: l.k, hr: l.hr, pitches: l.pitches },
    batters: pas.map((r) => ({ inning: r.inning, batter: r.batter || display(r.batter_key), outcome: r.outcome, seq: r.seq,
      pitches: ps.filter((x) => x.pa_idx === r.idx).map((x) => ({ no: x.pitch_no, balls: x.balls, strikes: x.strikes, type: x.pitch_type, velo: x.velo, call: x.call, x: x.plate_x, z: x.plate_z, ev: x.ev, la: x.la, side: x.batter_side })) })) };
}
