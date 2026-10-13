import { handler, access, canSeePlayer, isCoach } from "./_auth.js";
import { query, one } from "./_db.js";
import { nameKey } from "./_ncaa.js";
import { schoolSeo } from "./_sync.js";
import { keysFor } from "./_lookup.js";

// Pitch search and the pictures built from it: summary numbers, a heat map grid and spray points.
//   GET ?team=T [&player=P] [&season=2026] [&type=Fastball|fast|breaking|offspeed] [&count=0-2|ahead|behind|even|two]
//       [&result=swing|take|whiff|chase|inplay|hit|k] [&hand=L|R] [&opp=<seo>] [&limit=200]
//   Coaches can search any team's hitters too: &seo=<their team> [&batter=<key>]
// Coaches may search the whole team or any player; a player always gets only his own pitches.
// Pitch data comes from TrackMan (or the simulated demo season); play-by-play alone has no locations.
const FAST = ["Fastball", "Sinker", "Cutter"], BREAKING = ["Slider", "Sweeper", "Curveball"], OFFSPEED = ["Changeup", "Splitter", "Knuckleball"];
const SWING = ["swinging_strike", "foul", "in_play"];
const HIT = ["1B", "2B", "3B", "HR", "Single", "Double", "Triple", "HomeRun"];
// heat map: 5 x 5 cells over x -1.4..1.4 ft and z 0.9..4.1 ft (catcher's view); the middle 3 x 3 is the strike zone
const GX = [-1.4, -0.84, -0.28, 0.28, 0.84, 1.4], GZ = [0.9, 1.54, 2.18, 2.82, 3.46, 4.1];

export default handler(async (req, res, user) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  const teamId = String(req.query.team || "");
  const me = await access(user, teamId);
  if (!me) return res.status(404).json({ error: "not_found" });
  const team = await one(`SELECT * FROM teams WHERE id = $1`, [teamId]);
  const seo = team.ncaa_seo || "team:" + team.id;

  // whose pitches: one player (coach's choice, or the player himself), or the whole team for coaches
  let playerId = req.query.player ? String(req.query.player) : null;
  if (!isCoach(me)) playerId = me.playerId;
  if (playerId && !canSeePlayer(me, playerId)) return res.status(404).json({ error: "not_found" });
  const where = [], params = [];
  const add = (sql, ...v) => { let s = sql; v.forEach((x) => { params.push(x); s = s.replace("?", "$" + params.length); }); where.push(s); };
  const other = isCoach(me) && req.query.seo && String(req.query.seo) !== seo ? String(req.query.seo).toLowerCase() : null;
  if (other) {
    if (!/^[a-z0-9:_-]{2,80}$/.test(other)) return res.status(400).json({ error: "bad_request" });
    const bk = String(req.query.batter || "");
    if (bk) { if (!/^[a-z]+\|[a-z]?$/.test(bk)) return res.status(400).json({ error: "bad_request" }); add("batter_key = ANY(?::text[])", await keysFor(other, bk, "bat")); }
    add("bat_seo = ?", other);
  } else if (playerId) {
    const p = await one(`SELECT * FROM players WHERE id = $1 AND team_id = $2`, [playerId, teamId]);
    if (!p) return res.status(404).json({ error: "not_found" });
    const prev = p.prev_school ? await schoolSeo(p.prev_school) : null;
    add("batter_key = ?", nameKey(p.last_name, p.first_name));
    add("bat_seo = ANY(?::text[])", [seo, prev].filter(Boolean));
  } else add("bat_seo = ?", seo);
  const season = Number(req.query.season) || null;
  if (season) add("season = ?", season);
  const type = String(req.query.type || "");
  if (type === "fast") add("pitch_type = ANY(?::text[])", FAST); else if (type === "breaking") add("pitch_type = ANY(?::text[])", BREAKING);
  else if (type === "offspeed") add("pitch_type = ANY(?::text[])", OFFSPEED); else if (type) add("pitch_type = ?", type);
  const count = String(req.query.count || "");
  if (/^[0-3]-[0-2]$/.test(count)) { add("balls = ?", +count[0]); add("strikes = ?", +count[2]); }
  else if (count === "ahead") where.push("balls > strikes"); else if (count === "behind") where.push("strikes > balls");
  else if (count === "even") where.push("balls = strikes"); else if (count === "two") where.push("strikes = 2");
  const zone = "(abs(plate_x) <= 0.83 AND plate_z BETWEEN 1.5 AND 3.5)";
  const result = String(req.query.result || "");
  if (result === "swing") add("call = ANY(?::text[])", SWING); else if (result === "take") where.push("call IN ('ball','called_strike')");
  else if (result === "whiff") where.push("call = 'swinging_strike'"); else if (result === "chase") where.push(`call IN ('swinging_strike','foul','in_play') AND NOT ${zone}`);
  else if (result === "inplay") where.push("call = 'in_play'"); else if (result === "hit") add("call = 'in_play' AND result = ANY(?::text[])", HIT);
  else if (result === "k") where.push("result IN ('KL','KS','Strikeout')");
  if (req.query.hand === "L" || req.query.hand === "R") add("pitcher_throws = ?", req.query.hand);
  if (req.query.opp) add("pitch_seo = ?", String(req.query.opp));
  const W = where.length ? "WHERE " + where.join(" AND ") : "";

  const s = await one(`SELECT count(*)::int AS n, count(*) FILTER (WHERE call = ANY($${params.length + 1}::text[]))::int AS swings,
      count(*) FILTER (WHERE call = 'swinging_strike')::int AS whiffs, count(*) FILTER (WHERE NOT ${zone} AND plate_x IS NOT NULL)::int AS outz,
      count(*) FILTER (WHERE NOT ${zone} AND plate_x IS NOT NULL AND call = ANY($${params.length + 1}::text[]))::int AS chases,
      count(*) FILTER (WHERE ${zone})::int AS inz, count(*) FILTER (WHERE ${zone} AND call = ANY($${params.length + 1}::text[]))::int AS zswings,
      count(*) FILTER (WHERE call = 'in_play')::int AS bip, avg(ev) FILTER (WHERE call = 'in_play')::float AS ev, avg(la) FILTER (WHERE call = 'in_play')::float AS la,
      count(*) FILTER (WHERE call = 'in_play' AND ev >= 95)::int AS hard, max(ev)::float AS maxev, avg(velo)::float AS velo
    FROM pitches ${W}`, [...params, SWING]);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null), r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const summary = { pitches: s.n, swingPct: pct(s.swings, s.n), whiffPct: pct(s.whiffs, s.swings), chasePct: pct(s.chases, s.outz), zoneSwingPct: pct(s.zswings, s.inz),
    bip: s.bip, ev: r1(s.ev), la: r1(s.la), hardHitPct: pct(s.hard, s.bip), maxEv: r1(s.maxev), velo: r1(s.velo) };

  // heat map cells
  const cells = await query(`SELECT width_bucket(plate_x, $${params.length + 1}::float8[]) AS cx, width_bucket(plate_z, $${params.length + 2}::float8[]) AS cz,
      count(*)::int AS n, count(*) FILTER (WHERE call = ANY($${params.length + 3}::text[]))::int AS sw, count(*) FILTER (WHERE call = 'swinging_strike')::int AS wh,
      avg(ev) FILTER (WHERE call = 'in_play')::float AS ev, count(*) FILTER (WHERE call = 'in_play')::int AS bip, count(*) FILTER (WHERE call = 'in_play' AND ev >= 95)::int AS hard
    FROM pitches ${W ? W + " AND" : "WHERE"} plate_x IS NOT NULL GROUP BY 1, 2`, [...params, GX, GZ, SWING]);
  const grid = Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, col) => {
    const c = cells.find((x) => x.cx === col + 1 && x.cz === 5 - row);
    return c ? { n: c.n, swingPct: pct(c.sw, c.n), whiffPct: pct(c.wh, c.sw), ev: r1(c.ev), hardPct: pct(c.hard, c.bip), bip: c.bip } : { n: 0 };
  }));
  const spray = (await query(`SELECT bearing, distance, ev, la, result, hit_type FROM pitches ${W ? W + " AND" : "WHERE"} call = 'in_play' AND bearing IS NOT NULL AND distance IS NOT NULL LIMIT 1500`, params))
    .map((p) => ({ b: p.bearing, d: Math.round(p.distance), ev: p.ev, la: p.la, hit: HIT.includes(p.result), hr: p.result === "HR" || p.result === "HomeRun", t: p.hit_type }));
  // pitch locations for the smoothed heat map (a sample when there are many)
  const points = (await query(`SELECT plate_x AS x, plate_z AS z, call, ev FROM pitches ${W ? W + " AND" : "WHERE"} plate_x IS NOT NULL ORDER BY md5(id) LIMIT 3000`, params))
    .map((q) => ({ x: Math.round(q.x * 100) / 100, z: Math.round(q.z * 100) / 100, s: SWING.includes(q.call) ? 1 : 0, w: q.call === "swinging_strike" ? 1 : 0, ev: q.call === "in_play" && q.ev != null ? Math.round(q.ev) : null }));
  const limit = Math.min(500, Number(req.query.limit) || 150);
  const rows = (await query(`SELECT p.id, p.date, p.inning, p.balls, p.strikes, p.pitch_type, p.velo, p.call, p.ev, p.la, p.distance, p.result, p.pitcher_name, p.batter_name,
      p.pitcher_throws, p.video_url, p.plate_x, p.plate_z, g.home_seo, g.home_name, g.away_name
    FROM pitches p LEFT JOIN ncaa_games g ON g.id = p.game_id ${W.replace(/\b(batter_key|bat_seo|season|pitch_type|balls|strikes|call|result|pitcher_throws|pitch_seo|plate_x|plate_z)\b/g, "p.$1")}
    ORDER BY p.date DESC, p.inning DESC, p.pa_ref DESC, p.pitch_no DESC LIMIT ${limit}`, params))
    .map((r) => ({ ...r, opponent: r.home_seo === (other || seo) ? r.away_name : r.home_name, home: r.home_seo === (other || seo) }));
  const types = (await query(`SELECT pitch_type, count(*)::int AS n FROM pitches ${W} GROUP BY 1 ORDER BY 2 DESC`, params)).filter((t) => t.pitch_type);
  return res.json({ summary, grid, points, spray, rows, types, gridX: GX, gridZ: GZ });
});
