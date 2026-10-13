import { handler } from "./_auth.js";
import { query } from "./_db.js";

// GET -> { user: { id, name, admin }, teams: [{ id, name, shortName, season, demo, role, playerId }] }
// Admins see every team (as coach); everyone else sees the teams they belong to.
export default handler(async (req, res, user) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  const rows = user.is_admin
    ? await query(`SELECT t.*, COALESCE(m.role, 'coach') AS role, m.player_id FROM teams t
                   LEFT JOIN members m ON m.team_id = t.id AND m.user_id = $1 ORDER BY t.demo, t.name`, [user.id])
    : await query(`SELECT t.*, m.role, m.player_id FROM members m JOIN teams t ON t.id = m.team_id
                   WHERE m.user_id = $1 ORDER BY t.name`, [user.id]);
  return res.json({
    user: { id: user.id, name: user.name, admin: !!user.is_admin },
    teams: rows.map((t) => ({ id: t.id, name: t.name, shortName: t.short_name, season: t.season, demo: t.demo, role: t.role, playerId: t.player_id })),
  });
});
