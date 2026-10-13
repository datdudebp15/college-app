import { handler, access, isCoach, issueCode, newId } from "./_auth.js";
import { query, one } from "./_db.js";
import { clean } from "./_util.js";

// Sign-in codes. Coaches only. Every POST returns { code } once; it is never shown again.
//   POST   ?team=T { player: P }     a code for that player (a new one if he already had one)
//   POST   ?team=T { coach: "Name" } adds a coach to the staff
//   POST   ?team=T { user: U }       a new code for a coach on this team (the old one stops working)
//   DELETE ?team=T&user=U            removes a coach from the staff (never the last one)
export default handler(async (req, res, user, body) => {
  const teamId = String(req.query.team || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });
  if (!isCoach(me)) return res.status(403).json({ error: "coach_only" });

  if (req.method === "POST" && body.player) {
    const p = await one(`SELECT id, first_name, last_name FROM players WHERE id = $1 AND team_id = $2 AND active`, [String(body.player), teamId]);
    if (!p) return res.status(404).json({ error: "not_found" });
    let m = await one(`SELECT user_id FROM members WHERE player_id = $1`, [p.id]);
    if (!m) {
      const uid = newId("user");
      await query(`INSERT INTO users (id, name) VALUES ($1, $2)`, [uid, `${p.first_name} ${p.last_name}`]);
      await query(`INSERT INTO members (team_id, user_id, role, player_id) VALUES ($1, $2, 'player', $3)`, [teamId, uid, p.id]);
      m = { user_id: uid };
    }
    return res.json({ code: await issueCode(m.user_id) });
  }

  if (req.method === "POST" && body.coach) {
    const name = clean(body.coach, 80);
    if (!name) return res.status(400).json({ error: "name" });
    const uid = newId("user");
    await query(`INSERT INTO users (id, name) VALUES ($1, $2)`, [uid, name]);
    await query(`INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, 'coach')`, [teamId, uid]);
    return res.json({ code: await issueCode(uid), user: uid });
  }

  if (req.method === "POST" && body.user) {
    const m = await one(`SELECT user_id FROM members WHERE team_id = $1 AND user_id = $2 AND role = 'coach'`, [teamId, String(body.user)]);
    if (!m) return res.status(404).json({ error: "not_found" });
    return res.json({ code: await issueCode(m.user_id) });
  }

  if (req.method === "DELETE") {
    const uid = String(req.query.user || "");
    const m = await one(`SELECT user_id FROM members WHERE team_id = $1 AND user_id = $2 AND role = 'coach'`, [teamId, uid]);
    if (!m) return res.status(404).json({ error: "not_found" });
    const n = await one(`SELECT count(*)::int AS n FROM members WHERE team_id = $1 AND role = 'coach'`, [teamId]);
    if (n.n <= 1) return res.status(409).json({ error: "last_coach" });
    await query(`DELETE FROM users WHERE id = $1`, [uid]);
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: "method" });
});
