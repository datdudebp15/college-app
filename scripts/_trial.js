// Real players added to the demo team for a trial, from git-ignored files in trial/*.json, so their numbers
// never go into the repo. The dev server loads them after rebuilding the demo team. File shape:
//   { player: { first, last, pos, classYear, bats, throws, jersey }, seasons: [{ season, school, source, line, byPitch }] }
import fs from "node:fs";
import path from "node:path";
import { query } from "../api/_db.js";
import { DEMO_TEAM } from "./_seed.js";

export async function loadTrialPlayers(dir) {
  if (!fs.existsSync(dir)) return [];
  const added = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const p = d.player, id = "plr_trial_" + (p.last + p.first).toLowerCase().replace(/[^a-z]/g, "");
    await query(`INSERT INTO players (id, team_id, first_name, last_name, jersey, pos, bats, throws, class_year, real_person)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) ON CONFLICT (id) DO NOTHING`, [id, DEMO_TEAM.id, p.first, p.last, p.jersey, p.pos, p.bats, p.throws, p.classYear]);
    for (const s of d.seasons || []) {
      await query(`INSERT INTO player_seasons (player_id, season, school, source, line, by_pitch) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
        ON CONFLICT (player_id, season, school) DO UPDATE SET source = $4, line = $5::jsonb, by_pitch = $6::jsonb`,
        [id, s.season, s.school, s.source, JSON.stringify(s.line), s.byPitch ? JSON.stringify(s.byPitch) : null]);
    }
    added.push(`${p.first} ${p.last}`);
  }
  return added;
}
