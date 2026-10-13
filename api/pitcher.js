import { handler, access } from "./_auth.js";
import { query, one } from "./_db.js";
import { aliases } from "./_opponent.js";
import { today } from "./_sync.js";

// An opposing pitcher's page: line, arsenal, usage by count and by batter hand, location by pitch type,
// movement and release, recent outings, and how our hitters have done against him.
//   GET ?team=T&seo=<his team>&pitcher=<key> [&season=2026]
// Pitch-level parts need pitch tracking (TrackMan, or the simulated demo season); without it the page has
// his box-score line and outings only.
const SWING = ["swinging_strike", "foul", "in_play"];
const GX = [-1.4, -0.84, -0.28, 0.28, 0.84, 1.4], GZ = [0.9, 1.54, 2.18, 2.82, 3.46, 4.1];
const ZONE = "(abs(plate_x) <= 0.83 AND plate_z BETWEEN 1.5 AND 3.5)";
const BUCKETS = [
  ["First pitch", "balls = 0 AND strikes = 0"], ["He's ahead", "strikes > balls"], ["Even", "balls = strikes AND NOT (balls = 0 AND strikes = 0)"],
  ["He's behind", "balls > strikes"], ["Two strikes", "strikes = 2"], ["Full count", "balls = 3 AND strikes = 2"],
];

export default handler(async (req, res, user) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  const teamId = String(req.query.team || "");
  if (!(await access(user, teamId))) return res.status(404).json({ error: "not_found" });
  const team = await one(`SELECT * FROM teams WHERE id = $1`, [teamId]);
  const seo = String(req.query.seo || ""), key = String(req.query.pitcher || "");
  if (!/^[a-z0-9:_-]{2,80}$/.test(seo) || !/^[a-z]+\|[a-z]?$/.test(key)) return res.status(400).json({ error: "bad_request" });

  // all spellings of him on that team ("cervantes|" folds into "cervantes|a")
  const names = (await query(`SELECT DISTINCT name FROM ncaa_pitch_lines WHERE seo = $1 AND name LIKE $2`, [seo, key.split("|")[0] + "|%"])).map((r) => r.name);
  const al = aliases([...names, key]);
  const main = al[key] || key;
  const keys = [...new Set([main, ...Object.keys(al).filter((k) => al[k] === main)])];
  const T = today();
  const season = Number(req.query.season) || (await one(`SELECT max(g.season) AS s FROM ncaa_pitch_lines l JOIN ncaa_games g ON g.id = l.game_id WHERE l.seo = $1 AND l.name = ANY($2::text[]) AND g.date < $3`, [seo, keys, T]))?.s;
  if (!season) return res.status(404).json({ error: "not_found" });

  const outings = await query(`SELECT l.*, g.date, g.home_seo, g.home_name, g.away_name FROM ncaa_pitch_lines l JOIN ncaa_games g ON g.id = l.game_id
    WHERE l.seo = $1 AND l.name = ANY($2::text[]) AND g.season = $3 ORDER BY g.date DESC`, [seo, keys, season]);
  const sum = (k) => outings.reduce((s, o) => s + (o[k] || 0), 0);
  const outs = sum("outs"), bf = sum("bf");
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null), r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const display = outings.map((o) => o.display).find((d) => d && / /.test(d) && !d.includes("|")) || outings[0]?.display || main;
  const teamName = outings[0] ? (outings[0].home_seo === seo ? outings[0].home_name : outings[0].away_name) : seo;
  const line = { apps: outings.length, starts: outings.filter((o) => o.started).length, ip: Math.floor(outs / 3) + (outs % 3) / 10, bf,
    kPct: pct(sum("k"), bf), bbPct: pct(sum("bb"), bf), h: sum("h"), hr: sum("hr"), hPer9: outs ? r1((sum("h") / (outs / 3)) * 9) : null, pitchesPerBF: bf ? r1(sum("pitches") / bf) : null };
  const recent = outings.slice(0, 6).map((o) => ({ date: o.date, opponent: o.home_seo === seo ? o.away_name : o.home_name, started: o.started, ip: Math.floor(o.outs / 3) + (o.outs % 3) / 10, bf: o.bf, h: o.h, bb: o.bb, k: o.k, hr: o.hr, pitches: o.pitches }));

  const W = `pitch_seo = $1 AND pitcher_key = ANY($2::text[]) AND season = $3`, P = [seo, keys, season];
  const n = (await one(`SELECT count(*)::int AS n FROM pitches WHERE ${W}`, P)).n;
  const ourSeo = team.ncaa_seo || "team:" + team.id;
  const facedRows = await query(`SELECT pa.batter, pa.outcome, g.date FROM ncaa_pas pa JOIN ncaa_games g ON g.id = pa.game_id
    WHERE pa.pitch_seo = $1 AND pa.pitcher = ANY($2::text[]) AND pa.bat_seo = $3 ORDER BY g.date DESC`, [seo, keys, ourSeo]);
  const faced = {}; facedRows.forEach((r) => { (faced[r.batter] ||= []).push(r.outcome); });
  const base = { name: display, key: main, seo, team: teamName, season, line, recent, faced: Object.entries(faced).map(([name, outcomes]) => ({ name, outcomes })), tracked: n };
  if (!n) return res.json(base);

  const S = await one(`SELECT mode() WITHIN GROUP (ORDER BY pitcher_throws) AS throws, avg(extension)::float AS ext, avg(rel_height)::float AS rel,
      count(*) FILTER (WHERE balls = 0 AND strikes = 0)::int AS fp, count(*) FILTER (WHERE balls = 0 AND strikes = 0 AND (call <> 'ball' AND call <> 'hbp'))::int AS fps,
      count(*) FILTER (WHERE ${ZONE})::int AS inz FROM pitches WHERE ${W}`, P);
  const ars = await query(`SELECT pitch_type AS type, count(*)::int AS n, avg(velo)::float AS velo, max(velo)::float AS maxv, avg(spin)::float AS spin, avg(ivb)::float AS ivb, avg(hb)::float AS hb,
      count(*) FILTER (WHERE call = ANY($4::text[]))::int AS sw, count(*) FILTER (WHERE call = 'swinging_strike')::int AS wh, count(*) FILTER (WHERE call = 'called_strike')::int AS cs,
      count(*) FILTER (WHERE NOT ${ZONE})::int AS outz, count(*) FILTER (WHERE NOT ${ZONE} AND call = ANY($4::text[]))::int AS ch, count(*) FILTER (WHERE ${ZONE})::int AS inz,
      avg(ev) FILTER (WHERE call = 'in_play')::float AS ev, count(*) FILTER (WHERE call = 'in_play')::int AS bip, count(*) FILTER (WHERE call = 'in_play' AND ev >= 95)::int AS hard
    FROM pitches WHERE ${W} AND pitch_type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [...P, SWING]);
  const arsenal = ars.map((a) => ({ type: a.type, n: a.n, usage: pct(a.n, n), velo: r1(a.velo), maxVelo: r1(a.maxv), spin: a.spin == null ? null : Math.round(a.spin), ivb: r1(a.ivb), hb: r1(a.hb),
    whiffPct: pct(a.wh, a.sw), chasePct: pct(a.ch, a.outz), zonePct: pct(a.inz, a.n), cswPct: pct(a.cs + a.wh, a.n), ev: r1(a.ev), hardPct: pct(a.hard, a.bip) }));
  const types = arsenal.map((a) => a.type);
  const mix = async (cond) => { const rows = await query(`SELECT pitch_type AS type, count(*)::int AS n FROM pitches WHERE ${W} AND ${cond} AND pitch_type IS NOT NULL GROUP BY 1`, P);
    const tot = rows.reduce((s, r) => s + r.n, 0); return { n: tot, mix: Object.fromEntries(types.map((t) => [t, pct((rows.find((r) => r.type === t) || {}).n || 0, tot)])) }; };
  const byCount = []; for (const [label, cond] of BUCKETS) byCount.push({ label, ...(await mix(cond)) });
  const vsHand = [];
  for (const side of ["L", "R"]) {
    const m = await mix(`batter_side = '${side}'`);
    const r = await one(`SELECT count(*) FILTER (WHERE result IS NOT NULL)::int AS pa, count(*) FILTER (WHERE result IN ('KL','KS','Strikeout'))::int AS k,
        count(*) FILTER (WHERE result IN ('BB','Walk'))::int AS bb, count(*) FILTER (WHERE result IN ('1B','2B','3B','HR','Single','Double','Triple','HomeRun'))::int AS h,
        count(*) FILTER (WHERE call = 'swinging_strike')::int AS wh, count(*) FILTER (WHERE call = ANY($4::text[]))::int AS sw
      FROM pitches WHERE ${W} AND batter_side = '${side}'`, [...P, SWING]);
    vsHand.push({ side, ...m, pa: r.pa, kPct: pct(r.k, r.pa), bbPct: pct(r.bb, r.pa), hits: r.h, whiffPct: pct(r.wh, r.sw) });
  }
  // where each pitch goes: share of that pitch type's pitches in each cell (catcher's view)
  const cells = await query(`SELECT pitch_type AS type, width_bucket(plate_x, $4::float8[]) AS cx, width_bucket(plate_z, $5::float8[]) AS cz, count(*)::int AS n
    FROM pitches WHERE ${W} AND plate_x IS NOT NULL GROUP BY 1, 2, 3`, [...P, GX, GZ]);
  const grid = (type) => { const xs = cells.filter((c) => !type || c.type === type), tot = xs.reduce((s, c) => s + c.n, 0);
    return Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, col) => { const c = xs.filter((x) => x.cx === col + 1 && x.cz === 5 - row).reduce((s, x) => s + x.n, 0); return { n: c, share: pct(c, tot) }; })); };
  const locations = { All: grid(null), ...Object.fromEntries(types.map((t) => [t, grid(t)])) };
  const locPoints = (await query(`SELECT pitch_type AS t, plate_x AS x, plate_z AS z FROM pitches WHERE ${W} AND plate_x IS NOT NULL ORDER BY md5(id) LIMIT 3000`, P))
    .map((r) => ({ t: r.t, x: Math.round(r.x * 100) / 100, z: Math.round(r.z * 100) / 100 }));
  const movement = (await query(`SELECT pitch_type AS t, ivb, hb FROM pitches WHERE ${W} AND ivb IS NOT NULL AND hb IS NOT NULL AND pitch_type IS NOT NULL ORDER BY random() LIMIT 450`, P))
    .map((m) => ({ t: m.t, v: Math.round(m.ivb * 10) / 10, h: Math.round(m.hb * 10) / 10 }));
  return res.json({ ...base, throws: S.throws, extension: r1(S.ext), releaseHeight: r1(S.rel), firstPitchStrikePct: pct(S.fps, S.fp), zonePct: pct(S.inz, n),
    arsenal, byCount, vsHand, locations, locPoints, movement });
});
