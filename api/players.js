import { handler, access, isCoach, newId } from "./_auth.js";
import { query, one } from "./_db.js";
import { clean, player } from "./_util.js";

// Roster changes. Coaches only.
//   POST   ?team=T          { first, last, jersey, pos, bats, throws, classYear } -> { player }
//   PATCH  ?team=T&id=P     same fields, any subset
//   DELETE ?team=T&id=P     takes the player off the roster (kept for history) and ends his sign-in
export default handler(async (req, res, user, body) => {
  const teamId = String(req.query.team || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });
  if (!isCoach(me)) return res.status(403).json({ error: "coach_only" });

  if (req.method === "POST") {
    const f = fields(body);
    if (!f.first_name || !f.last_name) return res.status(400).json({ error: "name" });
    const id = newId("plr");
    await query(`INSERT INTO players (id, team_id, first_name, last_name, jersey, pos, bats, throws, class_year)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, teamId, f.first_name, f.last_name, f.jersey, f.pos, f.bats, f.throws, f.class_year]);
    return res.json({ player: player(await one(`SELECT * FROM players WHERE id = $1`, [id])) });
  }

  const id = String(req.query.id || "");
  const p = await one(`SELECT * FROM players WHERE id = $1 AND team_id = $2 AND active`, [id, teamId]);
  if (!p) return res.status(404).json({ error: "not_found" });

  if (req.method === "PATCH") {
    const f = fields({ ...player(p), ...body });
    if (!f.first_name || !f.last_name) return res.status(400).json({ error: "name" });
    await query(`UPDATE players SET first_name = $2, last_name = $3, jersey = $4, pos = $5, bats = $6, throws = $7, class_year = $8 WHERE id = $1`,
      [id, f.first_name, f.last_name, f.jersey, f.pos, f.bats, f.throws, f.class_year]);
    return res.json({ player: player(await one(`SELECT * FROM players WHERE id = $1`, [id])) });
  }

  if (req.method === "DELETE") {
    await query(`UPDATE players SET active = false WHERE id = $1`, [id]);
    await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM members WHERE player_id = $1)`, [id]);
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: "method" });
});

const POS = new Set(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "OF", "IF", "UT", "DH", "P"]);
const CLASS = new Set(["Fr", "So", "Jr", "Sr", "Gr", "RS Fr", "RS So", "RS Jr", "RS Sr"]);
function fields(b) {
  const pick = (v, set) => (set.has(v) ? v : null);
  return {
    first_name: clean(b.first, 40), last_name: clean(b.last, 40),
    jersey: /^\d{1,2}$/.test(String(b.jersey ?? "").trim()) ? String(b.jersey).trim() : null,
    pos: pick(String(b.pos || "").toUpperCase(), POS),
    bats: pick(b.bats, new Set(["R", "L", "S"])), throws: pick(b.throws, new Set(["R", "L"])),
    class_year: pick(b.classYear, CLASS),
  };
}
