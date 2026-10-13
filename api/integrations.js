import { handler, access, isCoach } from "./_auth.js";
import { query, one } from "./_db.js";
import { seal, open, canEncrypt } from "./_secrets.js";
import { testConnection, pullTeam } from "./_trackman_ftp.js";

// A team's data connections. Coaches only; credentials are write-only (never sent back to the browser).
//   GET    ?team=T                                  -> { canStore, sources: { trackman_ftp, trackman_live, trackman_api, synergy } }
//   PUT    ?team=T&source=trackman_ftp  { host, port, protocol, path, teamCode, username, password }
//          saves (password may be left out to keep the saved one), then tests the login -> { ok, test | error }
//   POST   ?team=T&source=trackman_ftp&action=pull  -> imports new files for ~45 s -> { done, imported, pitches, errors }
//   DELETE ?team=T&source=trackman_ftp              -> forgets the login (imported pitches stay)
export default handler(async (req, res, user, body) => {
  const teamId = String(req.query.team || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });
  if (!isCoach(me)) return res.status(403).json({ error: "coach_only" });
  const team = await one(`SELECT * FROM teams WHERE id = $1`, [teamId]);
  const source = String(req.query.source || "");

  if (req.method === "GET") return res.json(await status(team));
  if (source !== "trackman_ftp") return res.status(400).json({ error: "source" });

  if (req.method === "PUT") {
    if (!canEncrypt()) return res.status(503).json({ error: "no_integrations_key" });
    const cur = await one(`SELECT * FROM integrations WHERE team_id = $1 AND source = $2`, [teamId, source]);
    const old = cur && cur.secret ? open(cur.secret) : {};
    const cfg = {
      host: String(body.host || "").trim().toLowerCase(), port: Number(body.port) || 21,
      protocol: body.protocol === "ftp" ? "ftp" : "ftps", path: String(body.path || "/").trim() || "/",
      teamCode: String(body.teamCode || "").trim().toUpperCase() || null,
    };
    const creds = { username: String(body.username || "").trim() || old.username, password: body.password ? String(body.password) : old.password };
    if (!cfg.host || !creds.username || !creds.password) return res.status(400).json({ error: "missing", need: ["host", "username", "password"] });
    if (cfg.port < 1 || cfg.port > 65535 || cfg.path.length > 300) return res.status(400).json({ error: "bad_config" });
    const keep = cur ? { caughtUpTo: cur.config.caughtUpTo, codeCounts: cur.config.codeCounts } : {};
    await query(`INSERT INTO integrations (team_id, source, config, secret, enabled, status, updated_at) VALUES ($1, $2, $3::jsonb, $4, true, 'saved', now())
      ON CONFLICT (team_id, source) DO UPDATE SET config = $3::jsonb, secret = $4, enabled = true, status = 'saved', updated_at = now()`,
      [teamId, source, JSON.stringify({ ...keep, ...cfg }), seal(creds)]);
    try {
      const test = await testConnection(cfg, creds);
      await query(`UPDATE integrations SET status = 'connected', last_ok_at = now(), last_error = NULL WHERE team_id = $1 AND source = $2`, [teamId, source]);
      return res.json({ ok: true, test });
    } catch (e) {
      const err = friendly(e);
      await query(`UPDATE integrations SET status = 'error', last_error = $3 WHERE team_id = $1 AND source = $2`, [teamId, source, err]);
      return res.json({ ok: false, error: err });
    }
  }

  if (req.method === "POST" && req.query.action === "pull") {
    const integ = await one(`SELECT * FROM integrations WHERE team_id = $1 AND source = $2`, [teamId, source]);
    if (!integ || !integ.secret) return res.status(400).json({ error: "not_connected" });
    return res.json(await runPull(team, integ, 45000));
  }

  if (req.method === "DELETE") {
    await query(`DELETE FROM integrations WHERE team_id = $1 AND source = $2`, [teamId, source]);
    return res.json({ ok: true });
  }
  return res.status(405).json({ error: "method" });
});

/** One time-boxed pull, with the outcome recorded on the integration. Used here and by the nightly job. */
export async function runPull(team, integ, budgetMs, factory) {
  await query(`UPDATE integrations SET last_run_at = now() WHERE team_id = $1 AND source = $2`, [team.id, integ.source]);
  try {
    const r = await pullTeam(team, integ, open(integ.secret), { budgetMs, factory });
    await query(`UPDATE integrations SET status = 'connected', last_ok_at = now(), last_error = $3 WHERE team_id = $1 AND source = $2`,
      [team.id, integ.source, r.errors.length ? `${r.errors.length} file(s) couldn't be read` : null]);
    return r;
  } catch (e) {
    const err = friendly(e);
    await query(`UPDATE integrations SET status = 'error', last_error = $3 WHERE team_id = $1 AND source = $2`, [team.id, integ.source, err]);
    return { done: true, error: err, imported: 0, pitches: 0, errors: [] };
  }
}

function friendly(e) {
  const m = String((e && (e.code || e.message)) || "");
  if (/530|login|auth|password/i.test(m)) return "TrackMan refused the username or password.";
  if (e && e.code === "bad_host") return "That server address isn't allowed.";
  if (e && e.code === "host_not_found" || /ENOTFOUND/.test(m)) return "Couldn't find that server address.";
  if (/ETIMEDOUT|timeout/i.test(m)) return "The server didn't answer in time.";
  if (/ECONNREFUSED/.test(m)) return "The server refused the connection (check the port and FTP vs. FTPS).";
  if (/certificate|TLS|SSL/i.test(m)) return "The secure (FTPS) connection failed; try plain FTP if TrackMan says so.";
  return "Couldn't connect: " + m.slice(0, 120);
}

async function status(team) {
  const ftp = await one(`SELECT * FROM integrations WHERE team_id = $1 AND source = 'trackman_ftp'`, [team.id]);
  let username = null;
  try { username = ftp && ftp.secret ? open(ftp.secret).username : null; } catch { username = null; }
  const files = await one(`SELECT count(*)::int AS n, coalesce(sum(pitches), 0)::int AS p, max(imported_at) AS last FROM trackman_files WHERE team_id = $1 AND error IS NULL`, [team.id]);
  const live = await one(`SELECT validated_at, last_event_at FROM trackman_feeds WHERE team_id = $1`, [team.id]);
  return {
    canStore: canEncrypt(),
    sources: {
      trackman_ftp: ftp ? {
        connected: ftp.status === "connected", status: ftp.status, config: { host: ftp.config.host, port: ftp.config.port, protocol: ftp.config.protocol, path: ftp.config.path, teamCode: ftp.config.teamCode || null },
        detectedTeamCode: !ftp.config.teamCode && ftp.config.codeCounts ? Object.entries(ftp.config.codeCounts).sort((a, b) => b[1] - a[1])[0][0] : null,
        username, lastRunAt: ftp.last_run_at, lastOkAt: ftp.last_ok_at, lastError: ftp.last_error, caughtUpTo: ftp.config.caughtUpTo || null,
        files: files.n, pitches: files.p, lastImport: files.last,
      } : null,
      trackman_live: { configured: !!live, validatedAt: live && live.validated_at, lastEventAt: live && live.last_event_at },
      trackman_api: { available: false, note: "Per-pitch video and automatic data through TrackMan's Data API. Built once we have TrackMan's Quick Start guide." },
      synergy: { available: false, note: "Opponent video needs an agreement with Synergy (Sportradar)." },
    },
  };
}
