import { handler, access, isCoach, issueCode, newId } from "./_auth.js";
import { query, one } from "./_db.js";
import { clean, year, player } from "./_util.js";

// GET   ?id=T  -> { team, me: { role, playerId }, players, staff }
//                  Coaches get the whole roster with each player's sign-in status, and the staff list.
//                  Players get only their own record and no staff list.
// POST         (admin) { name, shortName, season, coachName } -> creates the team and its first coach,
//                  returns { team, code } where code is the coach's access code (shown once).
// PATCH ?id=T  (coach) { name, shortName, season, ncaaSeo }
export default handler(async (req, res, user, body) => {
  if (req.method === "POST") {
    if (!user.is_admin) return res.status(403).json({ error: "admin_only" });
    const name = clean(body.name, 80), coachName = clean(body.coachName, 80), season = year(body.season);
    if (!name || !coachName || !season) return res.status(400).json({ error: "missing", need: ["name", "coachName", "season"] });
    const id = newId("team"), uid = newId("user");
    await query(`INSERT INTO teams (id, name, short_name, season) VALUES ($1, $2, $3, $4)`, [id, name, clean(body.shortName, 24), season]);
    await query(`INSERT INTO users (id, name) VALUES ($1, $2)`, [uid, coachName]);
    await query(`INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, 'coach')`, [id, uid]);
    return res.json({ team: { id, name }, code: await issueCode(uid) });
  }

  const teamId = String(req.query.id || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });

  if (req.method === "GET") {
    const t = await one(`SELECT * FROM teams WHERE id = $1`, [teamId]);
    const team = { id: t.id, name: t.name, shortName: t.short_name, season: t.season, demo: t.demo, rosterUrl: t.roster_url, ncaaSeo: t.ncaa_seo };
    if (!isCoach(me)) {
      const p = await one(`SELECT * FROM players WHERE id = $1 AND team_id = $2`, [me.playerId, teamId]);
      return res.json({ team, me, players: p ? [player(p)] : [], staff: null });
    }
    const players = await query(`SELECT p.*, m.user_id, u.last_seen FROM players p
      LEFT JOIN members m ON m.player_id = p.id LEFT JOIN users u ON u.id = m.user_id
      WHERE p.team_id = $1 AND p.active ORDER BY p.last_name, p.first_name`, [teamId]);
    const staff = await query(`SELECT u.id, u.name, u.last_seen FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = $1 AND m.role = 'coach' ORDER BY u.name`, [teamId]);
    return res.json({
      team, me,
      players: players.map((p) => ({ ...player(p), access: p.user_id ? (p.last_seen ? "active" : "invited") : "none" })),
      staff: staff.map((s) => ({ id: s.id, name: s.name, access: s.last_seen ? "active" : "invited", you: s.id === user.id })),
    });
  }

  if (req.method === "PATCH") {
    if (!isCoach(me)) return res.status(403).json({ error: "coach_only" });
    const name = body.name === undefined ? undefined : clean(body.name, 80);
    if (name === "") return res.status(400).json({ error: "name" });
    const season = body.season === undefined ? undefined : year(body.season);
    if (season === null) return res.status(400).json({ error: "season" });
    const ncaa = body.ncaaSeo === undefined ? undefined : String(body.ncaaSeo).trim().toLowerCase();
    if (ncaa !== undefined && ncaa !== "" && !/^[a-z0-9-]{2,60}$/.test(ncaa)) return res.status(400).json({ error: "ncaa" });
    await query(`UPDATE teams SET name = COALESCE($2, name), short_name = COALESCE($3, short_name), season = COALESCE($4, season), ncaa_seo = CASE WHEN $5::text IS NULL THEN ncaa_seo ELSE NULLIF($5, '') END WHERE id = $1`,
      [teamId, name ?? null, body.shortName === undefined ? null : clean(body.shortName, 24), season ?? null, ncaa ?? null]);
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: "method" });
});

