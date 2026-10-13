// First-time NCAA backfill for a team (a few minutes: every scoreboard of four seasons, then each game).
//   node scripts/sync.js <app url> <coach or admin code> <team id>
//   node scripts/sync.js http://localhost:3020 ADMIN-LOCAL team_abc123
// Calls /api/sync until it reports done. Safe to stop and run again; it picks up where it left off.
const [url, code, team] = process.argv.slice(2);
if (!url || !code || !team) { console.error("Usage: node scripts/sync.js <app url> <code> <team id>"); process.exit(1); }
let dates = 0, games = 0;
for (let i = 1; ; i++) {
  const r = await fetch(`${url.replace(/\/$/, "")}/api/sync?team=${encodeURIComponent(team)}`, { method: "POST", headers: { Authorization: "Bearer " + code } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("sync failed:", r.status, j); process.exit(1); }
  dates += j.did?.dates || 0; games += j.did?.games || 0;
  console.log(`round ${i}: ${j.did?.dates || 0} scoreboards, ${j.did?.games || 0} games${j.done ? " - done" : ""}`);
  if (j.error) { console.error("stopped:", j.error); process.exit(1); }
  if (j.done) break;
}
console.log(`Finished: ${dates} scoreboards and ${games} games fetched.`);
