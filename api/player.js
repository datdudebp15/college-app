import { handler, access, canSeePlayer, isCoach } from "./_auth.js";
import { one } from "./_db.js";
import { player as shape } from "./_util.js";
import { playerProfile } from "./_profile.js";
import { note, seasonInput, postgameInput, opponentInput } from "./_writer.js";

// A player's page: his seasons, year over year, last game, next game and next opponent, with the write-ups.
//   GET  ?team=T&id=P          coaches: anyone on the team; players: only themselves
//   POST ?team=T&id=P          coaches: rewrite the write-ups with Claude now (otherwise the nightly job does it)
export default handler(async (req, res, user) => {
  const teamId = String(req.query.team || ""), id = String(req.query.id || "");
  const me = await access(user, teamId);
  if (!me || !canSeePlayer(me, id)) return res.status(404).json({ error: "not_found" });
  if (req.method === "POST" && !isCoach(me)) return res.status(403).json({ error: "coach_only" });
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "method" });

  const team = await one(`SELECT * FROM teams WHERE id = $1`, [teamId]);
  const p = await one(`SELECT * FROM players WHERE id = $1 AND team_id = $2 AND active`, [id, teamId]);
  if (!p) return res.status(404).json({ error: "not_found" });
  const profile = await playerProfile(team, p);
  const notes = {};
  if (profile.ready) {
    const write = req.method === "POST";
    const si = seasonInput(p, profile), pi = postgameInput(p, profile), oi = opponentInput(p, profile);
    if (si) notes.season = await note("season", p, team, String(profile.seasons[0].season), si, { write });
    if (pi) notes.postgame = await note("postgame", p, team, profile.lastGame.id, pi, { write });
    if (oi) notes.opponent = await note("opponent", p, team, `${profile.opponent.seo}:${profile.next.date}`, oi, { write });
  }
  return res.json({ player: { ...shape(p), prevSchool: p.prev_school }, profile, notes, claude: !!process.env.ANTHROPIC_API_KEY });
});
