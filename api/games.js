import { handler, access, canSeePlayer, isCoach } from "./_auth.js";
import { query, one } from "./_db.js";
import { nameKey } from "./_ncaa.js";
import { gameLog } from "./_gamelog.js";
import { teams, teamRoster, teamGames, hitterLog, pitcherLog } from "./_lookup.js";

// Game logs. Our hitters' games have each at-bat graded (by Claude when connected); coaches can also look up
// any team in the data, its hitters and pitchers, and their game logs.
//   GET  ?team=T&player=P [&season=2026]   -> { games: [{ id, date, opponent, home, us, them, line, pitches, grade }] }
//   GET  ?team=T&player=P&game=G           -> { game, atBats: [{ inning, pitcher, outcome, seq, pitches: [...], grade, summary }], gameGrade, note }
//   POST ?team=T&player=P&game=G           -> coaches: have Claude grade this game now (otherwise the nightly job does)
// Coaches only (any team):
//   GET  ?team=T&teams=1                   -> { teams: [{ seo, name, games, ours }] }
//   GET  ?team=T&seo=S&roster=1 [&season]  -> { name, seasons, season, hitters, pitchers }
//   GET  ?team=T&seo=S [&season] [&game=G] -> the team's game log, or one game's box
//   GET  ?team=T&seo=S&hitter=K [&season] [&game=G]   -> a hitter's game log, or one game's at-bats (rules grades)
//   GET  ?team=T&seo=S&pitcher=K [&season] [&game=G]  -> a pitcher's outings, or one outing's batters faced
// A player sees only himself.
export default handler(async (req, res, user) => {
  const teamId = String(req.query.team || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });
  const team = await one(`SELECT * FROM teams WHERE id = $1`, [teamId]);

  if (req.query.teams || req.query.seo) {
    if (!isCoach(me)) return res.status(403).json({ error: "coach_only" });
    if (req.method !== "GET") return res.status(405).json({ error: "method" });
    if (!team.ncaa_seo) return res.json(req.query.teams ? { teams: [] } : { games: [] });
    if (req.query.teams) return res.json({ teams: await teams(team) });
    const seo = String(req.query.seo).toLowerCase();
    if (!/^[a-z0-9:_-]{2,80}$/.test(seo)) return res.status(400).json({ error: "bad_request" });
    const gameId = req.query.game ? String(req.query.game) : null;
    let season = Number(req.query.season) || null;
    // on our own team, link hitters to their player pages (Claude-graded game logs)
    const link = async (hitters) => { if (seo !== team.ncaa_seo) return;
      const ps = await query(`SELECT id, first_name, last_name FROM players WHERE team_id = $1 AND active`, [team.id]);
      const by = new Map(ps.map((p) => [nameKey(p.last_name, p.first_name), p.id]));
      for (const h of hitters) h.playerId = by.get(h.key) || null; };
    if (req.query.roster) { const r = await teamRoster(seo, season); await link(r.hitters); return res.json(r); }
    if (!season && !gameId) season = (await teamRoster(seo, null)).season;
    const key = String(req.query.hitter || req.query.pitcher || "");
    if (key && !/^[a-z]+\|[a-z]?$/.test(key)) return res.status(400).json({ error: "bad_request" });
    const r = req.query.hitter ? await hitterLog(seo, key, season, gameId) : req.query.pitcher ? await pitcherLog(seo, key, season, gameId) : await teamGames(seo, season, gameId);
    if (r.notFound) return res.status(404).json({ error: "not_found" });
    if (r.hitters) await link(r.hitters);
    return res.json(r);
  }

  const playerId = isCoach(me) ? String(req.query.player || "") : me.playerId;
  if (!playerId || !canSeePlayer(me, playerId)) return res.status(404).json({ error: "not_found" });
  if (req.method === "POST" && !isCoach(me)) return res.status(403).json({ error: "coach_only" });
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "method" });
  const p = await one(`SELECT * FROM players WHERE id = $1 AND team_id = $2 AND active`, [playerId, teamId]);
  if (!p) return res.status(404).json({ error: "not_found" });
  if (!team.ncaa_seo) return res.json({ games: [] });

  const r = await gameLog(team, p, { season: Number(req.query.season) || null, gameId: req.query.game ? String(req.query.game) : null, write: req.method === "POST" });
  if (r.notFound) return res.status(404).json({ error: "not_found" });
  return res.json(r);
});
