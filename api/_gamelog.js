import { query, one } from "./_db.js";
import { hitterSeasons } from "./_profile.js";
import { gradeAtBat, gradeGame, zoneOf, spot } from "./_grade.js";
import { note, gameInput } from "./_writer.js";

/** A hitter's game list (no gameId) or one game with graded at-bats. write: let Claude grade it now. */
export async function gameLog(team, p, { season = null, gameId = null, write = false } = {}) {
  const { rows } = await hitterSeasons(team, p);

  const mine = rows.filter((r) => !season || r.season === season);
  const gameIds = [...new Set(mine.map((r) => r.game_id))];
  const pitches = gameIds.length ? await query(`SELECT * FROM pitches WHERE game_id = ANY($1::text[]) AND batter_key = ANY($2::text[]) ORDER BY game_id, pa_idx, pitch_no`, [gameIds, [...new Set(mine.map((r) => r.batter_key))]]) : [];
  const byPa = new Map(); for (const x of pitches) { const k = x.game_id + "|" + x.pa_idx; if (!byPa.has(k)) byPa.set(k, []); byPa.get(k).push(x); }
  const side = (x) => (p.bats === "S" ? (x && x.pitcher_throws === "R" ? "L" : "R") : p.bats || "R");
  const atBat = (r) => { const ps = byPa.get(r.game_id + "|" + r.idx) || []; return { r, ps, g: gradeAtBat(r, ps, side(ps[0])) }; };

  if (!gameId) {
    const games = [];
    for (const id of gameIds) {
      const ab = mine.filter((r) => r.game_id === id).map(atBat), g = ab[0].r, home = g.home_seo === g.bat_seo;
      const saved = await one(`SELECT data FROM notes WHERE player_id = $1 AND kind = 'game' AND key = $2`, [p.id, id]);
      games.push({ id, date: g.date, season: g.season, opponent: home ? g.away_name : g.home_name, home, us: home ? g.home_score : g.away_score, them: home ? g.away_score : g.home_score,
        line: line(ab.map((a) => a.r)), pitches: ab.reduce((s, a) => s + (a.ps.length || a.r.pitches || 0), 0),
        grade: saved ? saved.data.game.grade : gradeGame(ab.map((a) => a.g)).grade, by: saved ? "claude" : "rules" });
    }
    return ({ games: games.sort((a, b) => b.date.localeCompare(a.date)) });
  }

  const id = gameId;
  const ab = mine.filter((r) => r.game_id === id).map(atBat);
  if (!ab.length) return { notFound: true };
  const g = ab[0].r, home = g.home_seo === g.bat_seo;
  const game = { id, date: g.date, opponent: home ? g.away_name : g.home_name, home, us: home ? g.home_score : g.away_score, them: home ? g.away_score : g.home_score, line: line(ab.map((a) => a.r)) };
  const atBats = ab.map(({ r, ps, g: gr }, i) => ({
    n: i + 1, inning: r.inning, pitcher: r.pitcher_name, outcome: r.outcome, seq: r.seq, balls: r.balls, strikes: r.strikes, text: r.text,
    pitches: ps.map((x) => ({ no: x.pitch_no, balls: x.balls, strikes: x.strikes, type: x.pitch_type, velo: x.velo, spin: x.spin, call: x.call, x: x.plate_x, z: x.plate_z,
      zone: zoneOf(x.plate_x, x.plate_z), spot: spot(x.plate_x, x.plate_z, side(x)), ev: x.ev, la: x.la, distance: x.distance, video: x.video_url, throws: x.pitcher_throws })),
    rules: gr,
  }));
  const input = gameInput(p, game, atBats);
  const n = await note("game", p, team, id, input, { write });
  return ({ game, atBats: atBats.map((a, i) => ({ ...a, grade: (n.atBats && n.atBats[i] && n.atBats[i].grade) || a.rules.grade, summary: (n.atBats && n.atBats[i] && n.atBats[i].summary) || null })),
    gameGrade: (n.game && n.game.grade) || gradeGame(ab.map((a) => a.g)).grade, note: n, claude: !!process.env.ANTHROPIC_API_KEY });
}

export function line(pas) {
  const ab = pas.filter((r) => r.ab).length, h = pas.filter((r) => r.hit).length;
  const xbh = pas.filter((r) => /^(2B|3B|HR)$/.test(r.outcome)).map((r) => r.outcome);
  return { ab, h, bb: pas.filter((r) => /^(BB|IBB)$/.test(r.outcome)).length, k: pas.filter((r) => /^K/.test(r.outcome)).length, hbp: pas.filter((r) => r.outcome === "HBP").length, xbh, pa: pas.length };
}
