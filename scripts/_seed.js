// The demo team: a made-up school with made-up players, for screenshots, sales demos and local testing.
// Nothing here is a real person or program. Used by the dev server, the tests and scripts/seed-demo.js.
import { query, ensureSchema } from "../api/_db.js";
import { hashCode, newCode, newId } from "../api/_auth.js";

export const DEMO_TEAM = { id: "team_demo_ridgeline", name: "Ridgeline State Owls", short: "Ridgeline St.", season: 2026 };

const ROSTER = [
  ["Mason", "Avery", "2", "SS", "R", "R", "Jr"],
  ["Tate", "Kowalczyk", "4", "2B", "L", "R", "So"],
  ["Rafael", "Ibarra-Stone", "7", "CF", "S", "R", "Sr"],
  ["Cole", "Whitacre", "11", "3B", "R", "R", "RS So"],
  ["Jalen", "Okafor-Price", "14", "LF", "L", "L", "Fr"],
  ["Brody", "Lindqvist", "18", "1B", "L", "L", "Gr"],
  ["Nico", "Varela", "21", "C", "R", "R", "Jr"],
  ["Davis", "Pemberton", "23", "RF", "R", "R", "So"],
  ["Eli", "Marchetti", "27", "DH", "L", "R", "Sr"],
  ["Gavin", "Thornbury", "30", "C", "R", "R", "Fr"],
  ["Kai", "Nakashima-Ruiz", "33", "UT", "S", "R", "RS Jr"],
  ["Owen", "Fairweather", "35", "OF", "R", "L", "Fr"],
];

/**
 * Creates (or recreates) the demo team. codes: { coach, players: { "<last>": code } } to use fixed codes
 * (dev and tests), or omit for fresh random ones (production). Returns the codes it set.
 */
export async function seedDemo(codes = {}) {
  await ensureSchema();
  const T = DEMO_TEAM;
  await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM members WHERE team_id = $1)`, [T.id]);
  await query(`DELETE FROM teams WHERE id = $1`, [T.id]);
  await query(`INSERT INTO teams (id, name, short_name, season, demo) VALUES ($1, $2, $3, $4, true)`, [T.id, T.name, T.short, T.season]);

  const out = { coach: codes.coach || newCode(), players: {} };
  const coachId = newId("user");
  await query(`INSERT INTO users (id, name, code_hash) VALUES ($1, 'Coach Dale Hartwell', $2)`, [coachId, hashCode(out.coach)]);
  await query(`INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, 'coach')`, [T.id, coachId]);

  for (const [first, last, jersey, pos, bats, throws, cls] of ROSTER) {
    const pid = "plr_demo_" + last.toLowerCase().replace(/[^a-z]/g, "");
    await query(`INSERT INTO players (id, team_id, first_name, last_name, jersey, pos, bats, throws, class_year)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [pid, T.id, first, last, jersey, pos, bats, throws, cls]);
    // Two players get sign-ins so the player view can be shown; the rest are roster-only, like a real team at first.
    const code = codes.players?.[last] || (codes.players ? null : ["Avery", "Kowalczyk"].includes(last) ? newCode() : null);
    if (!code) continue;
    const uid = newId("user");
    await query(`INSERT INTO users (id, name, code_hash) VALUES ($1, $2, $3)`, [uid, `${first} ${last}`, hashCode(code)]);
    await query(`INSERT INTO members (team_id, user_id, role, player_id) VALUES ($1, $2, 'player', $3)`, [T.id, uid, pid]);
    out.players[last] = code;
  }
  return out;
}

/** Creates an admin (sees every team, can create teams) and returns the code. */
export async function createAdmin(name, code = newCode()) {
  await ensureSchema();
  await query(`INSERT INTO users (id, name, code_hash, is_admin) VALUES ($1, $2, $3, true)`, [newId("user"), name, hashCode(code)]);
  return code;
}

// Fixed codes for local development only (the dev server's database is in memory and never deployed).
export const DEV_CODES = { admin: "ADMIN-LOCAL", coach: "COACH-LOCAL", players: { Avery: "AVERY-LOCAL", Kowalczyk: "KOWAL-LOCAL" } };
