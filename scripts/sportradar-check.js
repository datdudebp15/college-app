// Checks the Sportradar key in .env.local and shows what it can reach, without printing the key.
//   node scripts/sportradar-check.js [team name, default "Virginia Tech"]
// Finds the NCAA baseball competition, its seasons, the team, and one game's play-by-play timeline, and
// saves raw responses to the scratch folder given in SR_OUT (or ./.devdb/sportradar) for building the connector.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env.local");
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { sr, hasKey, competitions, competitionSeasons, seasonCompetitors, seasonSummaries, sportEventTimeline } = await import("../api/_sportradar.js");
const out = process.env.SR_OUT || path.join(root, ".devdb", "sportradar");
fs.mkdirSync(out, { recursive: true });
const save = (name, j) => fs.writeFileSync(path.join(out, name + ".json"), JSON.stringify(j, null, 1));
const teamName = process.argv[2] || "Virginia Tech";

if (!hasKey()) { console.log("No key yet: put it after SYNERGY_API_KEY= in .env.local and save."); process.exit(1); }
try {
  const c = await competitions(); save("competitions", c);
  const all = c.competitions || [];
  console.log(`Key works (${process.env.SPORTRADAR_ACCESS || "trial"} access): ${all.length} baseball competitions.`);
  const ncaa = all.filter((x) => /ncaa|college/i.test(x.name + " " + (x.category?.name || "")));
  console.log("NCAA / college competitions:", ncaa.map((x) => `${x.name} [${x.id}]${x.gender ? " " + x.gender : ""}`).join("; ") || "none in this plan");
  const comp = ncaa.find((x) => /ncaa/i.test(x.name) && !/women|softball/i.test(x.name)) || ncaa[0];
  if (!comp) process.exit(0);
  const s = await competitionSeasons(comp.id); save("seasons", s);
  const seasons = (s.seasons || []).sort((a, b) => String(b.year).localeCompare(String(a.year)));
  console.log("Seasons:", seasons.map((x) => `${x.name} (${x.year}) [${x.id}]`).join("; "));
  const season = seasons.find((x) => (x.start_date || "") <= new Date().toISOString().slice(0, 10)) || seasons[0];
  const comps = await seasonCompetitors(season.id); save("competitors", comps);
  const teams = comps.season_competitors || comps.competitors || [];
  const team = teams.find((t) => new RegExp(teamName, "i").test(t.name + " " + (t.short_name || "")));
  console.log(`${season.name}: ${teams.length} teams; ${teamName}:`, team ? `${team.name} [${team.id}]` : "not found");
  const sum = await seasonSummaries(season.id); save("summaries", sum);
  const games = (sum.summaries || []).filter((g) => !team || (g.sport_event?.competitors || []).some((c) => c.id === team.id));
  const done = games.filter((g) => /closed|ended/.test(g.sport_event_status?.status || ""));
  console.log(`Games in this page of summaries: ${games.length} (${done.length} finished)` + ((sum.summaries || []).length >= 200 ? " — paged; more exist" : ""));
  const g = done[done.length - 1] || games[0];
  if (g) {
    const tl = await sportEventTimeline(g.sport_event.id); save("timeline", tl);
    const ev = tl.timeline || [];
    const types = {}; ev.forEach((e) => { types[e.type] = (types[e.type] || 0) + 1; });
    console.log(`Timeline for ${g.sport_event.competitors.map((c) => c.name).join(" vs ")} (${g.sport_event.start_time}): ${ev.length} events`);
    console.log("Event types:", Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));
    console.log("Sample events:", JSON.stringify(ev.slice(0, 3)).slice(0, 900));
  }
  console.log("Raw responses saved in", out);
} catch (e) {
  console.log("Failed:", e.code || e.message, e.status || "");
  if (e.code === "sportradar_denied") console.log("The key was refused. If it's a production key, set SPORTRADAR_ACCESS=production in .env.local.");
}
