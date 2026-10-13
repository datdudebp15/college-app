import { handler, access, isCoach } from "./_auth.js";
import { query, one } from "./_db.js";
import { ensureGame, nextGame, today } from "./_sync.js";
import { opponentStaff, matchupKeyed } from "./_opponent.js";
import { hitterSeasons } from "./_profile.js";

// Scouting: any opponent's pitchers, from their latest games, lined up against our hitters. Coaches only
// (a player sees his next opponent on his own page).
//   GET ?team=T             -> { choices: { upcoming: [...], lastSeason: [...] } }
//   GET ?team=T&opp=<seo>   -> { opponent, through, rotation, midweek, bullpen, complete, loaded, total }
// Their games are fetched on demand (box score + play-by-play) for about 40 seconds per call; while
// complete is false the app asks again and the report fills in.
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (d) => WD[new Date(d + "T12:00:00Z").getUTCDay()];

export default handler(async (req, res, user) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  const teamId = String(req.query.team || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });
  if (!isCoach(me)) return res.status(403).json({ error: "coach_only" });
  const team = await one(`SELECT * FROM teams WHERE id = $1`, [teamId]);
  const seo = team.ncaa_seo;
  if (!seo) return res.json({ error: "no_ncaa_team" });
  const T = today();

  if (!req.query.opp) {
    const upcoming = await query(`SELECT DISTINCT ON (opp) opp, name, date FROM (
        SELECT CASE WHEN home_seo = $1 THEN away_seo ELSE home_seo END AS opp, CASE WHEN home_seo = $1 THEN away_name ELSE home_name END AS name, date
        FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND date >= $2 AND state <> 'final') x WHERE opp NOT IN ('tba', '') AND name !~* '^tba$' ORDER BY opp, date`, [seo, T]);
    const last = await query(`SELECT opp, max(name) AS name, max(date) AS date, count(*)::int AS games FROM (
        SELECT CASE WHEN home_seo = $1 THEN away_seo ELSE home_seo END AS opp, CASE WHEN home_seo = $1 THEN away_name ELSE home_name END AS name, date, season
        FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND state = 'final') x
        WHERE opp NOT IN ('tba', '') AND name !~* '^tba$' AND season = (SELECT max(season) FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND state = 'final') GROUP BY opp ORDER BY max(date) DESC`, [seo]);
    return res.json({ choices: { upcoming: upcoming.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8), lastSeason: last } });
  }

  const opp = String(req.query.opp).toLowerCase();
  if (!/^[a-z0-9-]{2,60}$/.test(opp)) return res.status(400).json({ error: "opp" });
  // their latest season with games, and its last 20 games
  const latest = await one(`SELECT max(season) AS s FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND state = 'final' AND date < $2`, [opp, T]);
  if (!latest || !latest.s) return res.json({ opponent: { seo: opp, name: opp }, empty: true });
  const games = await query(`SELECT id, date, home_seo, home_name, away_name FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND state = 'final' AND season = $2 AND date < $3 ORDER BY date DESC LIMIT 20`, [opp, latest.s, T]);
  const name = games[0] ? (games[0].home_seo === opp ? games[0].home_name : games[0].away_name) : opp;
  const t0 = Date.now();
  let loaded = 0, complete = true;
  for (const g of games) {
    const have = await one(`SELECT 1 FROM ncaa_game_data WHERE game_id = $1 AND pbp IS NOT NULL`, [g.id]);
    if (have) { loaded++; continue; }
    if (Date.now() - t0 > 40000) { complete = false; break; }
    try { await ensureGame(g.id); loaded++; } catch { /* ncaa.com hiccup: leave it for the next call */ }
  }
  const through = games[0] && games[0].date;
  const staff = (await opponentStaff(opp, T)) || [];

  // weekend rotation: who started their most recent Friday, Saturday and Sunday games; midweek likewise
  const starts = await query(`SELECT l.name, l.display, g.date FROM ncaa_pitch_lines l JOIN ncaa_games g ON g.id = l.game_id
    WHERE l.seo = $1 AND l.started AND g.season = $2 AND g.date < $3 ORDER BY g.date DESC`, [opp, latest.s, T]);
  const byKey = new Map(staff.flatMap((s) => s.keys.map((k) => [k, s])));
  // each pitcher appears once: a day goes to the most recent starter on that day who isn't already listed
  const taken = new Set();
  const pick = (days) => days.map((d) => { const s = starts.find((x) => weekday(x.date) === d && byKey.get(x.name) && !taken.has(byKey.get(x.name).key)); if (!s) return null; taken.add(byKey.get(s.name).key); return { day: d, date: s.date, ...byKey.get(s.name) }; }).filter(Boolean);
  const rotation = pick(["Fri", "Sat", "Sun"]);
  const midweek = pick(["Tue", "Wed"]);
  const cutoff = new Date(Date.parse(through || T) - 21 * 864e5).toISOString().slice(0, 10);
  const used = new Set([...rotation, ...midweek].map((p) => p.key));
  const bullpen = staff.filter((s) => !used.has(s.key) && s.last >= cutoff && s.starts * 2 < s.apps).sort((a, b) => b.apps - a.apps).slice(0, 5);

  // our hitters' latest numbers, and what stands out against each pitcher
  const players = await query(`SELECT * FROM players WHERE team_id = $1 AND active ORDER BY last_name`, [teamId]);
  const cache = new Map(), hitters = [];
  for (const p of players) {
    const { seasons, keys } = await hitterSeasons(team, p, cache);
    const cur = seasons.find((s) => s.school === seo && s.metrics.pa >= 30);
    if (cur) hitters.push({ id: p.id, name: `${p.first_name} ${p.last_name}`, bats: p.bats, keys, m: cur.metrics });
  }
  // a note that fits most of the lineup is said once about the pitcher; hitter rows keep only what's specific to them
  const lineup = async (s) => {
    const per = hitters.map((h) => ({ h, notes: matchupKeyed(s, h.m) }));
    const count = {}; per.forEach((x) => x.notes.forEach((n) => { count[n.key] = (count[n.key] || 0) + 1; }));
    const shared = new Set(Object.keys(count).filter((k) => hitters.length >= 4 && count[k] >= hitters.length / 2));
    const tendencies = [...shared].map((k) => { const n = per.find((x) => x.notes.some((y) => y.key === k)).notes.find((y) => y.key === k); return `${n.about}. Fits ${count[k]} of your ${hitters.length} hitters.`; });
    const rows = [];
    for (const { h, notes } of per) {
      const own = notes.filter((n) => !shared.has(n.key)).map((n) => n.text);
      const faced = await query(`SELECT pa.outcome FROM ncaa_pas pa WHERE pa.batter_key = ANY($1::text[]) AND pa.bat_seo = $2 AND pa.pitch_seo = $3 AND pa.pitcher = ANY($4::text[])`, [h.keys, seo, opp, s.keys]);
      if (own.length || faced.length) rows.push({ id: h.id, name: h.name, notes: own, faced: faced.map((f) => f.outcome) });
    }
    return { ...s, tendencies, hitters: rows };
  };
  const out = async (xs) => { const r = []; for (const x of xs) r.push(await lineup(x)); return r; };
  const nx = await nextGame(seo);
  return res.json({
    opponent: { seo: opp, name }, season: latest.s, through, loaded, total: games.length, complete,
    next: nx && nx.opponentSeo === opp ? nx : null,
    rotation: await out(rotation), midweek: await out(midweek), bullpen: await out(bullpen), hitters: hitters.length,
  });
});
