import crypto from "node:crypto";
import { query, one, ensureSchema, hasDatabase } from "./_db.js";

// Sign-in is an access code the coach hands out ("K7QMX-4TRPW"). Only its SHA-256 hash is stored.
// Permissions, in one place:
//   admin  (Warren)  every team, can create teams
//   coach            everything on their team: roster, every player, staff
//   player           their own player record only, read-only roster details about themselves

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
export function newCode() {
  const b = crypto.randomBytes(10);
  const s = [...b].map((x) => ALPHA[x % ALPHA.length]).join("");
  return s.slice(0, 5) + "-" + s.slice(5);
}
export const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const hashCode = (c) => crypto.createHash("sha256").update(normCode(c)).digest("hex");
export const newId = (p) => p + "_" + crypto.randomBytes(8).toString("hex");

/** The signed-in user from "Authorization: Bearer <code>", or null. */
export async function signedIn(req) {
  const h = req.headers.authorization || "";
  const code = normCode(h.startsWith("Bearer ") ? h.slice(7) : "");
  if (code.length < 10) return null;
  await ensureSchema();
  const u = await one(`SELECT id, name, is_admin FROM users WHERE code_hash = $1`, [hashCode(code)]);
  if (!u) return null;
  // Admin preview: "X-View-As: coach" or "X-View-As: player:<id>" shows the app exactly as that person's
  // permissions allow, read-only. Ignored for everyone who isn't an admin.
  const va = String(req.headers["x-view-as"] || "");
  if (u.is_admin && va) {
    const m = va.match(/^(coach|player):?([A-Za-z0-9_]{0,64})$/);
    if (m && (m[1] === "coach" || m[2])) u.viewAs = { role: m[1], playerId: m[1] === "player" ? m[2] : null };
  }
  if (!u.viewAs) await query(`UPDATE users SET last_seen = now() WHERE id = $1`, [u.id]).catch(() => {});
  return u;
}

/** What this user may do on this team: { role: "coach" | "player", playerId } or null. Admins act as coaches. */
export async function access(user, teamId) {
  if (!user || !teamId) return null;
  if (user.viewAs) {
    if (user.viewAs.role === "coach") return (await one(`SELECT 1 FROM teams WHERE id = $1`, [teamId])) ? { role: "coach", playerId: null, preview: true } : null;
    const p = await one(`SELECT id FROM players WHERE id = $1 AND team_id = $2 AND active`, [user.viewAs.playerId, teamId]);
    return p ? { role: "player", playerId: p.id, preview: true } : null;
  }
  const m = await one(`SELECT role, player_id FROM members WHERE team_id = $1 AND user_id = $2`, [teamId, user.id]);
  if (m) return { role: m.role, playerId: m.player_id };
  if (user.is_admin && (await one(`SELECT 1 FROM teams WHERE id = $1`, [teamId]))) return { role: "coach", playerId: null, admin: true };
  return null;
}
export const isCoach = (a) => !!a && a.role === "coach";
/** Can see this player's data (dashboards, at-bats, grades): coaches see everyone, players see themselves. */
export const canSeePlayer = (a, playerId) => !!a && (a.role === "coach" || a.playerId === playerId);
/** SQL filter for player-scoped tables: null means every player on the team. */
export const playerScope = (a) => (a.role === "coach" ? null : a.playerId);

/** Shared request wrapper: JSON, no caching, signed in, database present, errors logged. */
export function handler(fn) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!hasDatabase()) return res.status(503).json({ error: "no_database" });
    try {
      const user = await signedIn(req);
      if (!user) return res.status(401).json({ error: "sign_in" });
      if (user.viewAs && req.method !== "GET") return res.status(403).json({ error: "preview_only" });
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
      return await fn(req, res, user, body && typeof body === "object" ? body : {});
    } catch (e) {
      console.error("api error", e);
      return res.status(500).json({ error: "server" });
    }
  };
}

/** Gives a user a fresh code (the old one stops working). Returns the code; it is shown once. */
export async function issueCode(userId) {
  const code = newCode();
  await query(`UPDATE users SET code_hash = $1 WHERE id = $2`, [hashCode(code), userId]);
  return code;
}
