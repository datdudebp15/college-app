import { Writable } from "node:stream";
import dns from "node:dns/promises";
import net from "node:net";
import { query, one } from "./_db.js";
import { trackmanPitches } from "./_trackman_csv.js";

// Automatic TrackMan import from the team's TrackMan file server (TrackMan's standard data delivery: game
// CSVs on FTP). The team enters its FTP login once on the Integrations screen; every night (and on
// "Pull now") new CSVs are found, read and loaded into the pitches table. Files already imported with the
// same size are skipped. Folders are walked newest first, and once a team is caught up only the last few
// days of dated folders (YYYY/MM/DD) are looked at.

const LOOKBACK_DAYS = 4;

/** A connected client. `factory` lets tests pass a fake. */
export async function connect(cfg, creds, factory) {
  if (factory) return factory(cfg, creds);
  await publicHost(cfg.host);
  const { Client } = await import("basic-ftp");
  const c = new Client(20000);
  await c.access({ host: cfg.host, port: cfg.port || 21, user: creds.username, password: creds.password, secure: cfg.protocol === "ftps", secureOptions: { servername: cfg.host } });
  return c;
}
async function publicHost(host) {
  if (!/^[a-z0-9.-]{3,253}$/i.test(host || "") || net.isIP(host)) throw Object.assign(new Error("bad host"), { code: "bad_host" });
  const addrs = await dns.lookup(host, { all: true }).catch(() => []);
  const priv = (ip) => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd]|fe80)/i.test(ip);
  if (!addrs.length) throw Object.assign(new Error("host not found"), { code: "host_not_found" });
  if (addrs.some((a) => priv(a.address))) throw Object.assign(new Error("private host"), { code: "bad_host" });
}

/** Lists the top folder: proves the login works and shows what's there. */
export async function testConnection(cfg, creds, factory) {
  const c = await connect(cfg, creds, factory);
  try { const list = await c.list(cfg.path || "/"); return { entries: list.length, sample: list.slice(0, 8).map((e) => e.name + (e.isDirectory ? "/" : "")) }; }
  finally { c.close(); }
}

/** Pull new files for one team, for up to budgetMs. Returns { done, listed, imported, pitches, errors }. */
export async function pullTeam(team, integ, creds, { budgetMs = 45000, factory } = {}) {
  const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
  const cfg = integ.config || {};
  const seen = new Map((await query(`SELECT path, size FROM trackman_files WHERE team_id = $1 AND error IS NULL`, [team.id])).map((r) => [r.path, Number(r.size)]));
  const caughtUp = cfg.caughtUpTo || null;   // newest date folder fully imported once
  const cutoff = caughtUp ? shift(caughtUp, -LOOKBACK_DAYS) : `${team.season - 2}-01-01`;
  const out = { done: true, listed: 0, imported: 0, pitches: 0, errors: [] };
  let newest = caughtUp;
  const c = await connect(cfg, creds, factory);
  try {
    const stack = [cfg.path || "/"];
    while (stack.length) {
      if (left() < 6000) { out.done = false; break; }
      const dir = stack.pop();
      const list = await c.list(dir); out.listed++;
      const full = (e) => (dir.endsWith("/") ? dir : dir + "/") + e.name;
      // newest first: push older folders first so the newest is popped next
      const dirs = list.filter((e) => e.isDirectory && !/^\./.test(e.name)).map(full).filter((p) => keepDir(p, cutoff)).sort();
      stack.push(...dirs);
      for (const f of list.filter((e) => e.isFile && /\.csv$/i.test(e.name)).sort((a, b) => b.name.localeCompare(a.name))) {
        const p = full(f);
        if (seen.get(p) === Number(f.size)) continue;
        if (left() < 6000) { out.done = false; break; }
        try {
          const text = await download(c, p);
          const n = await importCsv(team, integ, text);
          await query(`INSERT INTO trackman_files (team_id, path, size, imported_at, pitches, error) VALUES ($1,$2,$3,now(),$4,NULL)
            ON CONFLICT (team_id, path) DO UPDATE SET size = $3, imported_at = now(), pitches = $4, error = NULL`, [team.id, p, f.size, n]);
          out.imported++; out.pitches += n;
          const d = dateOf(p); if (d && (!newest || d > newest)) newest = d;
        } catch (e) {
          out.errors.push({ path: p, error: e.code || e.message });
          await query(`INSERT INTO trackman_files (team_id, path, size, imported_at, pitches, error) VALUES ($1,$2,$3,now(),0,$4)
            ON CONFLICT (team_id, path) DO UPDATE SET imported_at = now(), error = $4`, [team.id, p, f.size, String(e.code || e.message).slice(0, 200)]);
        }
      }
      if (!out.done) break;
    }
  } finally { c.close(); }
  if (out.done && newest && newest !== caughtUp) {
    await query(`UPDATE integrations SET config = config || $3::jsonb WHERE team_id = $1 AND source = $2`, [team.id, "trackman_ftp", JSON.stringify({ caughtUpTo: newest })]);
  }
  return out;
}
async function download(c, path) {
  const chunks = [];
  let size = 0;
  await c.downloadTo(new Writable({ write(chunk, enc, cb) { size += chunk.length; if (size > 25e6) return cb(new Error("file too large")); chunks.push(chunk); cb(); } }), path);
  return Buffer.concat(chunks).toString("utf8");
}
const shift = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** A dated folder (…/2026, …/2026/04, …/2026/04/18) is kept only if it can hold files on or after cutoff. */
function keepDir(p, cutoff) {
  const m = p.match(/(?:^|\/)(20\d\d)(?:\/(\d\d))?(?:\/(\d\d))?\/?$/);
  if (!m) return true;
  const [, y, mo, d] = m;
  if (d) return `${y}-${mo}-${d}` >= cutoff;
  if (mo) return `${y}-${mo}` >= cutoff.slice(0, 7);
  return y >= cutoff.slice(0, 4);
}
const dateOf = (p) => { const m = p.match(/(20\d\d)\/(\d\d)\/(\d\d)\//); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };

/**
 * One CSV into the pitches table. Our team is the TrackMan team code set on the integration, or else the code
 * in the most files so far. Each TrackMan game is matched to the NCAA game that day (doubleheaders in order of
 * first pitch), so pitches sit next to the play-by-play; unmatched games keep TrackMan's id.
 */
export async function importCsv(team, integ, text) {
  const ps = trackmanPitches(text);
  if (!ps.length) return 0;
  const cfg = integ.config || {};
  const codes = {}; ps.forEach((p) => [p.batterTeam, p.pitcherTeam].forEach((c) => { if (c) codes[c] = (codes[c] || 0) + 1; }));
  let code = cfg.teamCode;
  if (!code) {
    const counts = { ...(cfg.codeCounts || {}) }; Object.keys(codes).forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
    code = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    await query(`UPDATE integrations SET config = config || $3::jsonb WHERE team_id = $1 AND source = $2`, [team.id, "trackman_ftp", JSON.stringify({ codeCounts: counts })]);
  }
  const seo = team.ncaa_seo || "team:" + team.id;
  // TrackMan games in this file -> NCAA games that day
  const games = new Map();
  for (const p of ps) if (!games.has(p.gameRef)) games.set(p.gameRef, { date: p.date, first: p.time || "" });
  const byDate = {};
  for (const [ref, g] of games) (byDate[g.date] ||= []).push({ ref, ...g });
  const map = {};
  for (const [date, list] of Object.entries(byDate)) {
    const ncaa = team.ncaa_seo ? await query(`SELECT id, home_seo, away_seo FROM ncaa_games WHERE date = $1 AND (home_seo = $2 OR away_seo = $2) ORDER BY epoch NULLS LAST, id`, [date, seo]) : [];
    list.sort((a, b) => a.first.localeCompare(b.first)).forEach((g, i) => { const n = ncaa[i]; map[g.ref] = n ? { id: n.id, opp: n.home_seo === seo ? n.away_seo : n.home_seo } : { id: "tm:" + g.ref, opp: null }; });
  }
  const sideSeo = (tmCode, gameRef) => (tmCode === code ? seo : map[gameRef]?.opp || "tm:" + (tmCode || "unknown"));
  const rows = ps.map((p) => [
    p.id, map[p.gameRef]?.id || "tm:" + p.gameRef, null, p.pitchOfPa, p.date, p.date ? Number(p.date.slice(0, 4)) : null, p.inning,
    sideSeo(p.batterTeam, p.gameRef), sideSeo(p.pitcherTeam, p.gameRef), p.batter?.key || null, p.pitcher?.key || null, p.batterSide, p.pitcherThrows,
    p.balls, p.strikes, p.pitchType, p.velo, p.spin, p.plateX, p.plateZ, p.call, p.ev, p.la, p.bearing, p.distance, p.result, "trackman",
    p.gameRef && p.inning != null ? `${p.gameRef}:${p.inning}${p.top ? "t" : "b"}:${p.paOfInning}` : null, p.hitType,
    p.batter ? `${p.batter.first} ${p.batter.last}`.trim() : null, p.pitcher ? `${p.pitcher.first} ${p.pitcher.last}`.trim() : null,
  ]);
  const cols = ["id", "game_id", "pa_idx", "pitch_no", "date", "season", "inning", "bat_seo", "pitch_seo", "batter_key", "pitcher_key", "batter_side", "pitcher_throws",
    "balls", "strikes", "pitch_type", "velo", "spin", "plate_x", "plate_z", "call", "ev", "la", "bearing", "distance", "result", "source", "pa_ref", "hit_type", "batter_name", "pitcher_name"];
  for (let s = 0; s < rows.length; s += 150) {
    const chunk = rows.slice(s, s + 150), params = [];
    const values = chunk.map((r) => "(" + r.map((v) => { params.push(v); return "$" + params.length; }).join(",") + ")").join(",");
    await query(`INSERT INTO pitches (${cols.join(",")}) VALUES ${values}
      ON CONFLICT (id) DO UPDATE SET pitch_type = EXCLUDED.pitch_type, call = EXCLUDED.call, result = EXCLUDED.result, hit_type = EXCLUDED.hit_type,
        game_id = EXCLUDED.game_id, bat_seo = EXCLUDED.bat_seo, pitch_seo = EXCLUDED.pitch_seo`, params);
  }
  return ps.length;
}
