import { handler, access, isCoach, newId } from "./_auth.js";
import { query, one } from "./_db.js";
import { fetchRoster } from "./_roster.js";

// Roster import from the school's athletics site. Coaches only.
//   POST ?team=T { url, pitchers?: false } -> { added, updated, skipped, season }
// Players are matched by their id on the site, so importing again updates numbers, positions and classes
// without duplicating anyone. Nobody is removed: players who left stay until a coach removes them.
// Pitchers are skipped unless pitchers is true (this is a hitting app; two-way players are always kept).
export default handler(async (req, res, user, body) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  const teamId = String(req.query.team || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });
  if (!isCoach(me)) return res.status(403).json({ error: "coach_only" });

  let roster;
  try { roster = await fetchRoster(body.url); }
  catch (e) { return res.status(422).json({ error: e.code || "fetch_failed" }); }

  const keep = roster.players.filter((p) => body.pitchers || !p.pitcher);
  let added = 0, updated = 0;
  for (const p of keep) {
    const cur = await one(`SELECT id FROM players WHERE team_id = $1 AND source = 'site' AND source_id = $2`, [teamId, p.sourceId]);
    const vals = [p.first.slice(0, 40), p.last.slice(0, 40), /^\d{1,2}$/.test(p.jersey || "") ? p.jersey : null, p.pos, p.bats, p.throws, p.classYear, p.prevSchool];
    if (cur) {
      await query(`UPDATE players SET first_name = $2, last_name = $3, jersey = $4, pos = $5, bats = $6, throws = $7, class_year = $8, prev_school = $9, active = true WHERE id = $1`, [cur.id, ...vals]);
      updated++;
    } else {
      await query(`INSERT INTO players (id, team_id, first_name, last_name, jersey, pos, bats, throws, class_year, prev_school, source, source_id)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'site', $11)`, [newId("plr"), teamId, ...vals, p.sourceId]);
      added++;
    }
  }
  await query(`UPDATE teams SET roster_url = $2 WHERE id = $1`, [teamId, String(body.url).trim().slice(0, 500)]);
  return res.json({ added, updated, skipped: roster.players.length - keep.length, season: roster.season });
});
