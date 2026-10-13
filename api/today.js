import { handler, access, isCoach } from "./_auth.js";
import { query, one } from "./_db.js";
import { metrics } from "./_hitting.js";
import { hitterSeasons } from "./_profile.js";
import { nextGame, today } from "./_sync.js";

// The coach's morning view: the team's latest game and, for every hitter, his last seven games against his
// season so far. Coaches only.
//   GET ?team=T -> { asOf, seasonOver, lastGame, next, up: [...], strikeouts: [...], work: [...], steady: [...] }
// Trends compare the last seven games he played with his whole season; without pitch tracking there is no
// chase rate, so "swinging and missing more" uses strikeouts and misses per swing.
const RECENT = 7;

export default handler(async (req, res, user) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  const teamId = String(req.query.team || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });
  if (!isCoach(me)) return res.status(403).json({ error: "coach_only" });
  const team = await one(`SELECT * FROM teams WHERE id = $1`, [teamId]);
  const seo = team.ncaa_seo;
  if (!seo) return res.json({ error: "no_ncaa_team" });

  const lg = await one(`SELECT * FROM ncaa_games WHERE (home_seo = $1 OR away_seo = $1) AND state = 'final' ORDER BY date DESC, epoch DESC NULLS LAST LIMIT 1`, [seo]);
  if (!lg) return res.json({ empty: true });
  const players = await query(`SELECT * FROM players WHERE team_id = $1 AND active ORDER BY last_name`, [teamId]);
  const cache = new Map(), rows = [], box = [];
  for (const p of players) {
    const { rows: pas } = await hitterSeasons(team, p, cache);
    const mine = pas.filter((r) => r.season === lg.season && r.bat_seo === seo);
    const inLast = mine.filter((r) => r.game_id === lg.id);
    if (inLast.length) box.push({ id: p.id, name: `${p.first_name} ${p.last_name}`, ...line(inLast) });
    if (mine.length < 25) continue;
    const gameIds = [...new Set(mine.map((r) => r.game_id))], recentIds = new Set(gameIds.slice(-RECENT));
    const recent = mine.filter((r) => recentIds.has(r.game_id));
    const s = metrics(mine, p.bats), r = metrics(recent, p.bats);
    rows.push({ id: p.id, name: `${p.first_name} ${p.last_name}`, pos: p.pos, games: recentIds.size, season: pick(s), recent: pick(r),
      d: { ops: diff(r.ops, s.ops), k: diff(r.kPct, s.kPct), whiff: diff(r.whiffPct, s.whiffPct), bb: diff(r.bbPct, s.bbPct) } });
  }
  const up = rows.filter((x) => x.recent.pa >= 15 && x.d.ops >= 0.1).sort((a, b) => b.d.ops - a.d.ops);
  const strikeouts = rows.filter((x) => x.recent.pa >= 15 && (x.d.k >= 8 || x.d.whiff >= 8)).sort((a, b) => (b.d.k + b.d.whiff) - (a.d.k + a.d.whiff));
  const work = rows.filter((x) => x.recent.pa >= 15 && x.d.ops <= -0.15 && !strikeouts.includes(x)).sort((a, b) => a.d.ops - b.d.ops);
  const flagged = new Set([...up, ...strikeouts, ...work].map((x) => x.id));
  const home = lg.home_seo === seo;
  const T = today();
  return res.json({
    asOf: lg.date, seasonOver: (Date.parse(T) - Date.parse(lg.date)) / 864e5 > 10, season: lg.season,
    lastGame: { date: lg.date, opponent: home ? lg.away_name : lg.home_name, home, us: home ? lg.home_score : lg.away_score, them: home ? lg.away_score : lg.home_score, box },
    next: await nextGame(seo), up, strikeouts, work, steady: rows.filter((x) => !flagged.has(x.id)), recentGames: RECENT,
  });
});

const pick = (m) => ({ pa: m.pa, avg: m.avg, obp: m.obp, slg: m.slg, ops: m.ops, kPct: m.kPct, bbPct: m.bbPct, whiffPct: m.whiffPct });
const diff = (a, b) => (a == null || b == null ? 0 : Math.round((a - b) * 1000) / 1000);
function line(pas) {
  const ab = pas.filter((p) => p.ab).length, h = pas.filter((p) => p.hit).length;
  return { ab, h, bb: pas.filter((p) => /^(BB|IBB)$/.test(p.outcome)).length, k: pas.filter((p) => /^K/.test(p.outcome)).length,
    xbh: pas.filter((p) => /^(2B|3B|HR)$/.test(p.outcome)).map((p) => p.outcome), pitches: pas.reduce((s, p) => s + (p.pitches || 0), 0) };
}
