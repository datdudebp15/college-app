import { query, one } from "./_db.js";
import { nameKey } from "./_ncaa.js";
import { metrics, flags } from "./_hitting.js";
import { activeSeasons, nextGame, schoolSeo, today } from "./_sync.js";
import { opponentStaff, likelyStarter, matchup } from "./_opponent.js";

// Everything on a player's page, assembled from the NCAA data: his seasons (with year-over-year), his last game,
// his next game and the opponent's pitchers lined up against him. Claude's write-ups are attached by the caller.

export async function playerProfile(team, p) {
  const seo = team.ncaa_seo;
  if (!seo) return { ready: false, reason: "no_ncaa_team" };
  const key = nameKey(p.last_name, p.first_name), bare = key.split("|")[0] + "|";
  // some scorers write only the last name; count those too unless a teammate shares it
  const twin = await one(`SELECT 1 FROM players WHERE team_id = $1 AND active AND id <> $2 AND lower(regexp_replace(last_name, '[^A-Za-z]', '', 'g')) = $3`, [team.id, p.id, key.split("|")[0]]);
  const keys = twin ? [key] : [key, bare];
  const seasons = activeSeasons(team);
  const prevSeo = p.prev_school ? await schoolSeo(p.prev_school) : null;
  const schools = [seo, prevSeo].filter(Boolean);

  const rows = await query(`SELECT pa.*, g.date, g.season, g.home_seo, g.away_seo, g.home_name, g.away_name, g.home_score, g.away_score
    FROM ncaa_pas pa JOIN ncaa_games g ON g.id = pa.game_id
    WHERE pa.batter_key = ANY($1::text[]) AND pa.bat_seo = ANY($2::text[]) AND g.season = ANY($3::int[]) ORDER BY g.date, pa.game_id, pa.idx`, [keys, schools, seasons]);

  // one block per season and school (a transfer has his old school's seasons too)
  const groups = new Map();
  for (const r of rows) { const k = r.season + "|" + r.bat_seo; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const teamCache = new Map();
  const teamM = async (school, season) => {
    const k = school + "|" + season;
    if (!teamCache.has(k)) teamCache.set(k, metrics(await query(`SELECT pa.* FROM ncaa_pas pa JOIN ncaa_games g ON g.id = pa.game_id WHERE pa.bat_seo = $1 AND g.season = $2`, [school, season]), null));
    return teamCache.get(k);
  };
  const out = [];
  for (const [k, pas] of groups) {
    const [season, school] = k.split("|");
    const m = metrics(pas, p.bats), t = await teamM(school, +season);
    out.push({ season: +season, school, schoolName: pas[0].home_seo === school ? pas[0].home_name : pas[0].away_name, games: new Set(pas.map((x) => x.game_id)).size, metrics: m, team: teamLine(t), flags: flags(m, t) });
  }
  out.sort((a, b) => b.season - a.season);

  // last game he batted in
  let lastGame = null;
  if (rows.length) {
    const gid = rows[rows.length - 1].game_id, g = rows[rows.length - 1];
    const mine = rows.filter((r) => r.game_id === gid);
    const home = g.home_seo === g.bat_seo;
    lastGame = {
      id: gid, date: g.date, opponent: home ? g.away_name : g.home_name, home, us: home ? g.home_score : g.away_score, them: home ? g.away_score : g.home_score,
      pas: mine.map((r) => ({ inning: r.inning, outcome: r.outcome, seq: r.seq, balls: r.balls, strikes: r.strikes, pitches: r.pitches, bb: r.bb, field: r.field, pitcher: r.pitcher_name, text: r.text })),
    };
  }

  // next game and the opponent
  const next = await nextGame(seo);
  let opponent = null;
  if (next) {
    const staff = await opponentStaff(next.opponentSeo, next.date);
    const latest = out.find((s) => s.school === seo && s.metrics.pa >= 20) || out[0];
    if (staff && staff.length) {
      const starter = likelyStarter(staff, next.date);
      const cutoff = new Date(Date.parse(next.date) - 21 * 864e5).toISOString().slice(0, 10);
      const pen = staff.filter((s) => s.name !== starter?.name && s.last >= cutoff && s.starts * 2 < s.apps).sort((a, b) => b.apps - a.apps).slice(0, 4);
      const faced = async (pk) => (await query(`SELECT pa.outcome, pa.seq, pa.balls, pa.strikes, g.date FROM ncaa_pas pa JOIN ncaa_games g ON g.id = pa.game_id
        WHERE pa.batter_key = ANY($1::text[]) AND pa.bat_seo = $2 AND pa.pitch_seo = $3 AND pa.pitcher = $4 ORDER BY g.date`, [keys, seo, next.opponentSeo, pk]));
      const card = async (s, role) => ({ ...s, role, notes: matchup(s, latest && latest.metrics), faced: await faced(s.key) });
      opponent = {
        name: next.opponentName, seo: next.opponentSeo,
        starter: starter ? { ...(await card(staff.find((s) => s.name === starter.name), "starter")), why: starter.why } : null,
        bullpen: await Promise.all(pen.map((s) => card(s, "bullpen"))),
      };
    } else opponent = { name: next.opponentName, seo: next.opponentSeo, starter: null, bullpen: [], empty: true };
  }

  return { ready: true, ncaaTeam: seo, prevSchool: p.prev_school, prevSeo, seasons: out, lastGame, next, opponent, asOf: today() };
}
const teamLine = (t) => ({ avg: t.avg, obp: t.obp, slg: t.slg, kPct: t.kPct, bbPct: t.bbPct, whiffPct: t.whiffPct, fpSwingPct: t.fpSwingPct, gbPct: t.batted.gbPct });
