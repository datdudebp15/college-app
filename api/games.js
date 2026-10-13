import { handler, access, canSeePlayer, isCoach } from "./_auth.js";
import { query, one } from "./_db.js";
import { gameLog } from "./_gamelog.js";

// A hitter's game log and each game's at-bats, graded on process.
//   GET  ?team=T&player=P [&season=2026]   -> { games: [{ id, date, opponent, home, us, them, line, pitches, grade }] }
//   GET  ?team=T&player=P&game=G           -> { game, atBats: [{ inning, pitcher, outcome, seq, pitches: [...], grade, summary }], gameGrade, note }
//   POST ?team=T&player=P&game=G           -> coaches: have Claude grade this game now (otherwise the nightly job does)
// Coaches see anyone on the team; a player sees only himself.
export default handler(async (req, res, user) => {
  const teamId = String(req.query.team || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });
  const playerId = isCoach(me) ? String(req.query.player || "") : me.playerId;
  if (!playerId || !canSeePlayer(me, playerId)) return res.status(404).json({ error: "not_found" });
  if (req.method === "POST" && !isCoach(me)) return res.status(403).json({ error: "coach_only" });
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "method" });
  const team = await one(`SELECT * FROM teams WHERE id = $1`, [teamId]);
  const p = await one(`SELECT * FROM players WHERE id = $1 AND team_id = $2 AND active`, [playerId, teamId]);
  if (!p) return res.status(404).json({ error: "not_found" });
  if (!team.ncaa_seo) return res.json({ games: [] });

  const r = await gameLog(team, p, { season: Number(req.query.season) || null, gameId: req.query.game ? String(req.query.game) : null, write: req.method === "POST" });
  if (r.notFound) return res.status(404).json({ error: "not_found" });
  return res.json(r);
});
