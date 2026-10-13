import { query, one } from "./_db.js";
import { scoreboard, boxscore, playByPlay, schoolsIndex, parseGame, PARSER_VERSION } from "./_ncaa.js";
import { isDemoSeo, demoSchoolSeo } from "./_demo.js";

// Keeps a team's NCAA data current. Work is done in small steps until a time budget runs out, then the
// caller asks again (the nightly job loops; the backfill script loops). Every step is safe to repeat.
//   1. scoreboards for every date of the seasons we care about (past dates once, recent dates again, future weekly)
//   2. box score + play-by-play for the team's finished games
//   3. transfers: games at their previous school
//   4. the next opponent's recent games, for the opponent report

export const SEASONS_BACK = 3; // the current season and three before it: enough for a senior's career

/** Today as YYYY-MM-DD. OC_TODAY pins it for local testing (e.g. 2026-04-15 to see an in-season week). */
export const today = () => process.env.OC_TODAY || new Date().toISOString().slice(0, 10);
export const seasonOf = (date) => Number(date.slice(0, 4));
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function seasonDates(y) { const out = []; for (let d = `${y}-02-10`; d <= `${y}-06-30`; d = addDays(d, 1)) out.push(d); return out; }

/** The team's season and the ones before it, newest first. */
export const activeSeasons = (team) => Array.from({ length: SEASONS_BACK + 1 }, (_, i) => team.season - i);

export async function syncTeam(team, budgetMs = 45000) {
  const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
  const did = { dates: 0, games: 0 };
  const seo = team.ncaa_seo || (await guessSeo(team));
  if (!seo) return { done: true, error: "no_ncaa_team", did };
  if (isDemoSeo(seo)) return { done: true, did }; // the demo league is simulated, never fetched
  const T = today(), seasons = activeSeasons(team);

  // 1. scoreboards
  for (const y of seasons) {
    for (const d of seasonDates(y)) {
      if (left() < 4000) return { done: false, did };
      const row = await one(`SELECT fetched_at FROM ncaa_dates WHERE date = $1`, [d]);
      const age = row ? (Date.now() - new Date(row.fetched_at)) / 3.6e6 : Infinity;
      const recent = d >= addDays(T, -3) && d <= addDays(T, 1), future = d > addDays(T, 1);
      const fetchedAfterFinal = row && new Date(row.fetched_at) > new Date(addDays(d, 2) + "T00:00:00Z");
      const stale = !row || (recent && age > 3) || (future && age > 24 * 7) || (!recent && !future && !fetchedAfterFinal);
      if (!stale) continue;
      const games = await scoreboard(d);
      for (const g of games) await saveGame(g, y);
      await query(`INSERT INTO ncaa_dates (date, fetched_at, games) VALUES ($1, now(), $2) ON CONFLICT (date) DO UPDATE SET fetched_at = now(), games = $2`, [d, games.length]);
      did.dates++;
    }
  }

  // 2-4. games to fetch, most useful first
  const want = [];
  want.push(...(await finalGames(seo, seasons)));
  for (const p of await query(`SELECT DISTINCT prev_school FROM players WHERE team_id = $1 AND active AND prev_school IS NOT NULL`, [team.id])) {
    const prevSeo = await schoolSeo(p.prev_school);
    if (prevSeo && prevSeo !== seo) want.push(...(await finalGames(prevSeo, seasons.slice(1))));
  }
  const next = await nextGame(seo);
  if (next) want.push(...(await finalGames(next.opponentSeo, [seasonOf(next.date), seasonOf(next.date) - 1])).slice(-20));
  for (const id of want) {
    if (left() < 5000) return { done: false, did };
    try { if (await ensureGame(id)) did.games++; }
    catch (e) {
      // one game ncaa.com can't serve right now mustn't stop the rest; it's tried again tomorrow
      if (e.code !== "ncaa_unavailable") throw e;
      await query(`INSERT INTO ncaa_game_data (game_id, parser_v, fetched_at) VALUES ($1, 0, now()) ON CONFLICT (game_id) DO UPDATE SET fetched_at = now()`, [id]);
      did.skipped = (did.skipped || 0) + 1;
    }
  }
  return { done: true, did };
}

async function saveGame(g, season) {
  await query(`INSERT INTO ncaa_games (id, date, season, epoch, state, time, home_seo, home_name, home_score, away_seo, away_name, away_score)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
               ON CONFLICT (id) DO UPDATE SET date=$2, epoch=$4, state=$5, time=$6, home_score=$9, away_score=$12`,
    [g.id, g.date, season, g.epoch, g.state, g.time, g.home.seo, g.home.name, g.home.score, g.away.seo, g.away.name, g.away.score]);
}
async function finalGames(seo, seasons) {
  const rows = await query(`SELECT id FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND state = 'final' AND season = ANY($2::int[]) ORDER BY date`, [seo, seasons]);
  return rows.map((r) => r.id);
}

/** Fetches and parses one game if we don't have it (or the parser has improved since). Returns true if it did work. */
export async function ensureGame(id) {
  if (String(id).startsWith("demo-")) return false;
  const have = await one(`SELECT parser_v, (box IS NOT NULL AND pbp IS NOT NULL) AS full, fetched_at FROM ncaa_game_data WHERE game_id = $1`, [id]);
  if (have && have.full && have.parser_v === PARSER_VERSION) return false;
  if (have && !have.full && Date.now() - new Date(have.fetched_at) < 864e5) return false; // missing or failed: retry once a day
  let box, pbp;
  if (have && have.full) ({ box, pbp } = await one(`SELECT box, pbp FROM ncaa_game_data WHERE game_id = $1`, [id]));
  else { box = await boxscore(id); pbp = await playByPlay(id); }
  if (!pbp) { await query(`INSERT INTO ncaa_game_data (game_id, box, pbp, parser_v) VALUES ($1, $2::jsonb, NULL, 0) ON CONFLICT (game_id) DO NOTHING`, [id, box ? JSON.stringify(box) : null]); return true; }
  const g = parseGame(box, pbp);
  await query(`DELETE FROM ncaa_pas WHERE game_id = $1`, [id]);
  await query(`DELETE FROM ncaa_pitch_lines WHERE game_id = $1`, [id]);
  await insertRows("ncaa_pas", ["game_id", "idx", "inning", "bat_seo", "pitch_seo", "batter_key", "batter", "pitcher", "pitcher_name", "outcome", "seq", "balls", "strikes", "pitches", "swings", "whiffs", "fouls", "called", "in_play", "hit", "ab", "bb", "field", "text"],
    g.pas.map((p, i) => [id, i, p.inning, p.batSeo, p.pitchSeo, p.key, [p.first, p.last].filter(Boolean).join(" "), p.pitcher, p.pitcherName, p.outcome, p.seq, p.balls, p.strikes, p.pitches, p.swings, p.whiffs, p.fouls, p.called, p.inPlay, p.hit, p.ab, p.bb, p.field, p.text]));
  await insertRows("ncaa_pitch_lines", ["game_id", "seo", "name", "display", "started", "bf", "outs", "h", "bb", "k", "hbp", "hr", "pitches"],
    g.pitchers.map((L) => [id, L.seo, L.name, L.display, L.started, L.bf, L.outs, L.h, L.bb, L.k, L.hbp, L.hr, L.pitches]));
  await query(`INSERT INTO ncaa_game_data (game_id, box, pbp, parser_v, fetched_at) VALUES ($1, $2::jsonb, $3::jsonb, $4, now())
               ON CONFLICT (game_id) DO UPDATE SET box = $2::jsonb, pbp = $3::jsonb, parser_v = $4, fetched_at = now()`, [id, box ? JSON.stringify(box) : null, JSON.stringify(pbp), PARSER_VERSION]);
  return true;
}

/** Many rows in one statement (one round trip to the database instead of one per row). */
async function insertRows(table, cols, rows) {
  for (let s = 0; s < rows.length; s += 200) {
    const chunk = rows.slice(s, s + 200), params = [];
    const values = chunk.map((r) => "(" + r.map((v) => { params.push(v); return "$" + params.length; }).join(",") + ")").join(",");
    await query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values} ON CONFLICT DO NOTHING`, params);
  }
}

/** The team's next game that hasn't been played: { id, date, time, epoch, home, opponentSeo, opponentName } or null. */
export async function nextGame(seo) {
  const g = await one(`SELECT * FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND date >= $2 AND state <> 'final' ORDER BY date, epoch NULLS LAST LIMIT 1`, [seo, today()]);
  if (!g) return null;
  const home = g.home_seo === seo;
  return { id: g.id, date: g.date, time: g.time, epoch: g.epoch, home, opponentSeo: home ? g.away_seo : g.home_seo, opponentName: home ? g.away_name : g.home_name };
}

/* ---------- names -> NCAA teams ---------- */
async function schools() {
  const row = await one(`SELECT v, updated_at FROM kv WHERE k = 'ncaa_schools'`);
  if (row && Date.now() - new Date(row.updated_at) < 30 * 864e5) return row.v;
  const list = await schoolsIndex();
  if (list) await query(`INSERT INTO kv (k, v, updated_at) VALUES ('ncaa_schools', $1, now()) ON CONFLICT (k) DO UPDATE SET v = $1, updated_at = now()`, [JSON.stringify(list)]);
  return list || (row && row.v) || [];
}
const norm = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
/** "Belmont" -> "belmont". Exact name or full name only; anything uncertain is left out rather than guessed. */
export async function schoolSeo(name) {
  const demo = demoSchoolSeo(name); if (demo) return demo;
  const n = norm(name); if (!n) return null;
  const hit = (await schools()).find((s) => norm(s.name) === n || norm(s.long) === n || s.slug === n.replace(/ /g, "-"));
  return hit ? hit.slug : null;
}
/** "Virginia Tech Hokies" -> "virginia-tech": the longest school name the team name starts with. Saved on the team. */
async function guessSeo(team) {
  const n = norm(team.name);
  const best = (await schools()).filter((s) => n === norm(s.name) || n.startsWith(norm(s.name) + " ")).sort((a, b) => b.name.length - a.name.length)[0];
  if (!best) return null;
  await query(`UPDATE teams SET ncaa_seo = $2 WHERE id = $1`, [team.id, best.slug]);
  team.ncaa_seo = best.slug;
  return best.slug;
}
