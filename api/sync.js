import { signedIn, access, isCoach } from "./_auth.js";
import { query, hasDatabase, ensureSchema } from "./_db.js";
import { syncTeam, today } from "./_sync.js";
import { playerProfile } from "./_profile.js";
import { note, seasonInput, postgameInput, opponentInput } from "./_writer.js";

// Pulls NCAA games for a team and writes the players' notes. Each call works for up to ~50 seconds and says
// whether there's more; callers repeat until done.
//   POST ?team=T                         a coach, from the Team tab (or scripts/sync.js for a first backfill)
//   GET  (x-cron-key: CRON_SECRET)       the nightly job: every team, then the notes that are due
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDatabase()) return res.status(503).json({ error: "no_database" });
  try {
    await ensureSchema();
    const budget = 50000, t0 = Date.now();
    if (req.method === "POST") {
      const user = await signedIn(req);
      if (!user) return res.status(401).json({ error: "sign_in" });
      if (user.viewAs) return res.status(403).json({ error: "preview_only" });
      const me = await access(user, String(req.query.team || ""));
      if (!me) return res.status(404).json({ error: "not_found" });
      if (!isCoach(me)) return res.status(403).json({ error: "coach_only" });
      const team = (await query(`SELECT * FROM teams WHERE id = $1`, [req.query.team]))[0];
      return res.json(await syncTeam(team, budget));
    }
    if (req.method === "GET") {
      if (!process.env.CRON_SECRET || req.headers["x-cron-key"] !== process.env.CRON_SECRET) return res.status(401).json({ error: "cron_only" });
      const teams = await query(`SELECT * FROM teams WHERE NOT demo ORDER BY id`);
      for (const team of teams) {
        const r = await syncTeam(team, budget - (Date.now() - t0));
        if (!r.done) return res.json({ done: false, team: team.id, step: "games" });
      }
      // notes: postgame for games in the last two days, opponent for games in the next six, season when it changed
      const T = today(), soon = new Date(Date.parse(T) + 6 * 864e5).toISOString().slice(0, 10), recent = new Date(Date.parse(T) - 2 * 864e5).toISOString().slice(0, 10);
      let written = 0;
      for (const team of teams) {
        for (const p of await query(`SELECT * FROM players WHERE team_id = $1 AND active ORDER BY id`, [team.id])) {
          if (Date.now() - t0 > budget) return res.json({ done: false, step: "notes", written });
          const prof = await playerProfile(team, p);
          if (!prof.ready) continue;
          const si = seasonInput(p, prof), pi = prof.lastGame && prof.lastGame.date >= recent && postgameInput(p, prof), oi = prof.next && prof.next.date <= soon && opponentInput(p, prof);
          if (si) { await note("season", p, team, String(prof.seasons[0].season), si, { write: true }); written++; }
          if (pi) { await note("postgame", p, team, prof.lastGame.id, pi, { write: true }); written++; }
          if (oi) { await note("opponent", p, team, `${prof.opponent.seo}:${prof.next.date}`, oi, { write: true }); written++; }
        }
      }
      return res.json({ done: true, written });
    }
    return res.status(405).json({ error: "method" });
  } catch (e) {
    console.error("sync error", e);
    return res.status(e.code === "ncaa_unavailable" ? 502 : 500).json({ error: e.code || "server" });
  }
}
