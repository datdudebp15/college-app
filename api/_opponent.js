import { query } from "./_db.js";

// The next opponent's pitchers, from their recent box scores and play-by-play, and how each one lines up
// against one of our hitters. Without pitch tracking we can't see pitch types, velocity or location, and
// ncaa.com doesn't publish which hand a pitcher throws with; this works from what the play-by-play shows.

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (date) => new Date(date + "T12:00:00Z").getUTCDay();
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function opponentStaff(seo, beforeDate) {
  const lines = await query(`SELECT l.*, g.date FROM ncaa_pitch_lines l JOIN ncaa_games g ON g.id = l.game_id
    WHERE l.seo = $1 AND g.date < $2 AND g.state = 'final' ORDER BY g.date DESC LIMIT 400`, [seo, beforeDate]);
  if (!lines.length) return null;
  const pas = await query(`SELECT p.pitcher, p.seq, p.outcome, p.in_play, p.bb, p.swings, p.whiffs, p.pitches, p.called FROM ncaa_pas p JOIN ncaa_games g ON g.id = p.game_id
    WHERE p.pitch_seo = $1 AND g.date < $2 AND g.date >= $3`, [seo, beforeDate, lines[lines.length - 1].date]);
  const byName = new Map();
  for (const L of lines) {
    const P = byName.get(L.name) || { name: L.name, apps: 0, starts: 0, outs: 0, bf: 0, k: 0, bb: 0, h: 0, hr: 0, pitches: 0, startDays: [], last: null, recent: [] };
    P.apps++; if (L.started) { P.starts++; P.startDays.push(L.date); }
    P.outs += L.outs; P.bf += L.bf; P.k += L.k; P.bb += L.bb; P.h += L.h; P.hr += L.hr; P.pitches += L.pitches;
    P.last ??= L.date; if (P.recent.length < 4) P.recent.push({ date: L.date, started: L.started, outs: L.outs, bf: L.bf, k: L.k, bb: L.bb, h: L.h, pitches: L.pitches });
    byName.set(L.name, P);
  }
  const staff = [...byName.values()].map((P) => {
    const xs = pas.filter((p) => p.pitcher === P.name);
    const first = xs.map((p) => (p.seq ? p.seq[0] : p.in_play ? "X" : null)).filter(Boolean);
    const bip = xs.filter((p) => p.in_play && p.bb && p.bb !== "BU");
    const sw = xs.reduce((s, p) => s + p.swings, 0), wh = xs.reduce((s, p) => s + p.whiffs, 0);
    const ks = xs.filter((p) => /^K/.test(p.outcome));
    return {
      name: display(P.name), key: P.name, apps: P.apps, starts: P.starts, ip: ip(P.outs), last: P.last, recent: P.recent,
      startWeekdays: [...new Set(P.startDays.slice(0, 6).map((d) => WD[weekday(d)]))],
      kPct: pct(P.k, P.bf), bbPct: pct(P.bb, P.bf), hPer9: P.outs ? Math.round((P.h / (P.outs / 3)) * 9 * 10) / 10 : null, hr: P.hr,
      pitchesPerBF: P.bf ? Math.round((P.pitches / P.bf) * 10) / 10 : null,
      fpStrikePct: pct(first.filter((c) => /[KSFX]/.test(c)).length, first.length), whiffPct: pct(wh, sw),
      kLookingShare: pct(ks.filter((p) => p.outcome === "KL").length, ks.length), gbPct: pct(bip.filter((p) => p.bb === "GB").length, bip.length), bip: bip.length,
    };
  });
  return staff.sort((a, b) => b.starts - a.starts || b.ip - a.ip);
}

/** Who is likely to start on the date of the game: the pitcher who started their most recent game on that weekday. */
export function likelyStarter(staff, gameDate) {
  if (!staff || !staff.length) return null;
  const wd = WD[weekday(gameDate)];
  const sameDay = staff.filter((p) => p.recent.some((r) => r.started && WD[weekday(r.date)] === wd))
    .sort((a, b) => (b.recent.find((r) => r.started && WD[weekday(r.date)] === wd).date).localeCompare(a.recent.find((r) => r.started && WD[weekday(r.date)] === wd).date));
  const pick = sameDay[0] || staff.filter((p) => p.starts).sort((a, b) => a.last.localeCompare(b.last))[0];
  return pick ? { name: pick.name, why: sameDay[0] ? `started their last ${wd} game` : "is next in line by rest" } : null;
}

/** How a pitcher's habits meet a hitter's: plain observations from both sets of numbers, no advice. */
export function matchup(p, m) {
  if (!p || !m) return [];
  const out = [], f = (x) => `${Math.round(x)}%`;
  if (p.fpStrikePct >= 62 && m.fpSwingPct != null && m.fpSwingPct <= 25)
    out.push(`He throws a first-pitch strike ${f(p.fpStrikePct)} of the time, and you take the first pitch ${f(100 - m.fpSwingPct)} of the time, so expect to start 0-1 often.`);
  if (p.whiffPct >= 24 && m.whiffPct >= 22) out.push(`He gets misses on ${f(p.whiffPct)} of swings against him; you miss on ${f(m.whiffPct)} of yours.`);
  else if (p.whiffPct != null && p.whiffPct <= 16 && m.whiffPct != null) out.push(`Hitters put the ball in play against him: only ${f(p.whiffPct)} of swings miss.`);
  if (p.kLookingShare >= 35 && m.klShare >= 35 && m.k >= 6) out.push(`${f(p.kLookingShare)} of his strikeouts are called; ${f(m.klShare)} of yours are too.`);
  if (p.gbPct >= 50 && p.bip >= 20 && m.batted.gbPct >= 45) out.push(`He keeps the ball on the ground (${f(p.gbPct)} of balls in play), and ${f(m.batted.gbPct)} of yours are grounders.`);
  if (p.bbPct >= 12 && m.fpSwingPct >= 40) out.push(`He walks ${f(p.bbPct)} of the hitters he faces, and you swing at the first pitch ${f(m.fpSwingPct)} of the time.`);
  if (p.pitchesPerBF >= 4.2) out.push(`His plate appearances run long: ${p.pitchesPerBF} pitches per batter.`);
  return out;
}

const ip = (outs) => Math.floor(outs / 3) + (outs % 3) / 10;
/** "Bryan,Sam" -> "Sam Bryan" */
export const display = (n) => { const [l, f] = String(n || "").split(","); return f ? `${f} ${l.replace(/(Jr|II|III)$/, " $1")}`.trim() : n; };
