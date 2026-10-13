import crypto from "node:crypto";
import { handler, access, isCoach } from "./_auth.js";
import { query, one, ensureSchema, hasDatabase } from "./_db.js";

// TrackMan live feed ("in-session play-by-play" for Portable B1, same format family as Stadium V3).
// TrackMan calls two webhooks per team, which the team gives to TrackMan support:
//   POST /api/trackman?feed=<token>&kind=session    session start / end
//   POST /api/trackman?feed=<token>&kind=ball       one message per tracked pitch or hit (no player names)
// TrackMan can't sign in, so the secret token in the URL identifies the team. Every message is stored raw
// and answered at once: TrackMan sends each one once, with no retries. A SubscriptionValidation message is
// answered with { validationResponse: <validationCode> }, in the plain form or the Event Grid array form.
// Coaches:
//   GET  ?team=T            -> { session, ball, validatedAt, lastEventAt, events } (the two URLs, created on first use)
//   POST ?team=T&rotate=1   -> new token; the old URLs stop working
export default async function (req, res) {
  if (req.query.feed) return webhook(req, res);
  return coachView(req, res);
}

async function webhook(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!hasDatabase()) return res.status(503).json({ error: "no_database" });
  try {
    await ensureSchema();
    const feed = await one(`SELECT team_id FROM trackman_feeds WHERE token = $1`, [String(req.query.feed)]);
    if (!feed) return res.status(404).json({ error: "unknown_feed" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); } }
    if (!body || typeof body !== "object") return res.status(400).json({ error: "bad_body" });
    if (JSON.stringify(body).length > 512 * 1024) return res.status(413).json({ error: "too_large" });

    const events = Array.isArray(body) ? body : [body];
    const code = events.map(validationCode).find(Boolean);
    if (code) {
      await query(`UPDATE trackman_feeds SET validated_at = now() WHERE team_id = $1`, [feed.team_id]);
      return res.json({ validationResponse: code });
    }
    const kind = req.query.kind === "session" ? "session" : "ball";
    for (const e of events) {
      const d = e && typeof e === "object" && e.data && typeof e.data === "object" ? e.data : e;
      await query(`INSERT INTO trackman_events (team_id, kind, session_id, play_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [feed.team_id, kind, pickId(d, /^session(id|_id)?$/i), pickId(d, /^(play|pitch|ball)(id|_id)$/i), JSON.stringify(e)]);
    }
    await query(`UPDATE trackman_feeds SET last_event_at = now() WHERE team_id = $1`, [feed.team_id]);
    return res.json({ ok: true, stored: events.length });
  } catch (e) {
    console.error("trackman webhook error", e);
    return res.status(500).json({ error: "server" });
  }
}

/** The validation code from either { validationCode } / { data: { validationCode } } or an Event Grid event. */
function validationCode(e) {
  if (!e || typeof e !== "object") return null;
  const d = e.data && typeof e.data === "object" ? e.data : e;
  const v = d.validationCode ?? d.ValidationCode ?? e.validationCode;
  return typeof v === "string" && v.length <= 200 ? v : null;
}
/** A top-level or one-level-down id field, e.g. SessionId / sessionId / PlayId. */
function pickId(d, re) {
  if (!d || typeof d !== "object") return null;
  for (const [k, v] of Object.entries(d)) if (re.test(k) && (typeof v === "string" || typeof v === "number")) return String(v).slice(0, 120);
  for (const v of Object.values(d)) if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, w] of Object.entries(v)) if (re.test(k) && (typeof w === "string" || typeof w === "number")) return String(w).slice(0, 120);
  return null;
}

const coachView = handler(async (req, res, user) => {
  const teamId = String(req.query.team || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });
  if (!isCoach(me)) return res.status(403).json({ error: "coach_only" });
  let feed = await one(`SELECT * FROM trackman_feeds WHERE team_id = $1`, [teamId]);
  if (req.method === "POST" && req.query.rotate) {
    const token = crypto.randomBytes(24).toString("base64url");
    await query(`INSERT INTO trackman_feeds (team_id, token) VALUES ($1, $2) ON CONFLICT (team_id) DO UPDATE SET token = $2, validated_at = NULL`, [teamId, token]);
    feed = await one(`SELECT * FROM trackman_feeds WHERE team_id = $1`, [teamId]);
  } else if (req.method === "GET" && !feed) {
    await query(`INSERT INTO trackman_feeds (team_id, token) VALUES ($1, $2) ON CONFLICT (team_id) DO NOTHING`, [teamId, crypto.randomBytes(24).toString("base64url")]);
    feed = await one(`SELECT * FROM trackman_feeds WHERE team_id = $1`, [teamId]);
  } else if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "method" });
  const origin = process.env.APP_URL || `${req.headers["x-forwarded-proto"] || "https"}://${req.headers["x-forwarded-host"] || req.headers.host || "localhost"}`;
  const url = (kind) => `${origin.replace(/\/$/, "")}/api/trackman?feed=${feed.token}&kind=${kind}`;
  const n = await one(`SELECT count(*)::int AS n, max(received_at) AS last FROM trackman_events WHERE team_id = $1 AND received_at > now() - interval '30 days'`, [teamId]);
  return res.json({ session: url("session"), ball: url("ball"), validatedAt: feed.validated_at, lastEventAt: feed.last_event_at, events30d: n.n });
});
