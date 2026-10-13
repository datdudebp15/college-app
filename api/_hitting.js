// Hitting numbers from play-by-play plate appearances. Everything here is arithmetic on what happened; Claude
// only explains these numbers later, it never computes them.
// Each PA row: outcome, seq (B/K/S/F before the final pitch, or including it for strikeouts and walks), balls and
// strikes before the final pitch, pitches, swings, whiffs, fouls, called, in_play, hit, ab, bb (GB/LD/FB/PU/BU), field (L/C/R).

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const rate3 = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);

export function metrics(pas, bats) {
  const n = (f) => pas.filter(f).length;
  const PA = pas.length, AB = n((p) => p.ab), H = n((p) => p.hit);
  const D2 = n((p) => p.outcome === "2B"), D3 = n((p) => p.outcome === "3B"), HR = n((p) => p.outcome === "HR");
  const BB = n((p) => /^(BB|IBB)$/.test(p.outcome)), HBP = n((p) => p.outcome === "HBP"), SF = n((p) => p.outcome === "SF");
  const K = n((p) => /^K/.test(p.outcome)), KL = n((p) => p.outcome === "KL");
  const TB = H + D2 + 2 * D3 + 3 * HR;
  const sum = (k) => pas.reduce((s, p) => s + (p[k] || 0), 0);
  const pitches = sum("pitches"), swings = sum("swings"), whiffs = sum("whiffs"), called = sum("called");

  // first pitch: the first letter of the sequence, or the ball put in play on 0-0
  const known = pas.filter((p) => p.seq != null); // some scorers leave the count off
  const first = known.map((p) => (p.seq ? p.seq[0] : p.in_play ? "X" : p.outcome === "HBP" ? "H" : null)).filter(Boolean);
  const fpSwing = first.filter((c) => /[SFX]/.test(c)).length, fpStrike = first.filter((c) => /[KSFX]/.test(c)).length;

  // counts: the count before the pitch that ended the plate appearance
  const bucket = (p) => (p.balls > p.strikes ? "ahead" : p.strikes > p.balls ? "behind" : "even");
  const byCount = {};
  for (const b of ["ahead", "even", "behind"]) {
    const xs = known.filter((p) => bucket(p) === b), ab = xs.filter((p) => p.ab).length, h = xs.filter((p) => p.hit).length;
    byCount[b] = { pa: xs.length, avg: rate3(h, ab) };
  }
  const two = known.filter((p) => p.strikes >= 2);
  const twoFouls = two.reduce((s, p) => s + twoStrikeFouls(p.seq), 0);

  const bip = pas.filter((p) => p.in_play && p.bb && p.bb !== "BU");
  const dir = pas.filter((p) => p.in_play && p.field && p.bb !== "BU");
  const pull = bats === "R" ? "L" : bats === "L" ? "R" : null, oppo = bats === "R" ? "R" : bats === "L" ? "L" : null;
  const gbDir = dir.filter((p) => p.bb === "GB");

  const obpDen = AB + BB + HBP + SF;
  const avg = rate3(H, AB), obp = rate3(H + BB + HBP, obpDen), slg = rate3(TB, AB);
  return {
    pa: PA, ab: AB, h: H, d2: D2, d3: D3, hr: HR, bb: BB, hbp: HBP, k: K, kl: KL,
    avg, obp, slg, ops: obp != null && slg != null ? Math.round((obp + slg) * 1000) / 1000 : null, iso: slg != null && avg != null ? Math.round((slg - avg) * 1000) / 1000 : null,
    kPct: pct(K, PA), bbPct: pct(BB, PA), klShare: pct(KL, K),
    pitchesPerPA: known.length ? Math.round((pitches / known.length) * 100) / 100 : null, seqPA: known.length,
    swingPct: pct(swings, pitches), whiffPct: pct(whiffs, swings), calledPct: pct(called, pitches - swings),
    fpSwingPct: pct(fpSwing, first.length), fpStrikePct: pct(fpStrike, first.length),
    twoStrike: { pa: two.length, kPct: pct(two.filter((p) => /^K/.test(p.outcome)).length, two.length), avg: rate3(two.filter((p) => p.hit).length, two.filter((p) => p.ab).length), foulsPerPA: two.length ? Math.round((twoFouls / two.length) * 100) / 100 : null },
    byCount,
    batted: { n: bip.length, gbPct: pct(bip.filter((p) => p.bb === "GB").length, bip.length), ldPct: pct(bip.filter((p) => p.bb === "LD").length, bip.length),
      fbPct: pct(bip.filter((p) => p.bb === "FB").length, bip.length), puPct: pct(bip.filter((p) => p.bb === "PU").length, bip.length) },
    direction: { n: dir.length, pullPct: pull ? pct(dir.filter((p) => p.field === pull).length, dir.length) : null, centerPct: pct(dir.filter((p) => p.field === "C").length, dir.length),
      oppoPct: oppo ? pct(dir.filter((p) => p.field === oppo).length, dir.length) : null, gbPullPct: pull ? pct(gbDir.filter((p) => p.field === pull).length, gbDir.length) : null },
    xbhPerBip: pct(D2 + D3 + HR, pas.filter((p) => p.in_play).length),
  };
}
function twoStrikeFouls(seq) {
  let s = 0, f = 0;
  for (const c of seq || "") { if (c === "F" && s >= 2) f++; if (c === "K" || c === "S" || (c === "F" && s < 2)) s++; }
  return f;
}

/**
 * Strengths and weaknesses: where he differs clearly from his own team that season, with enough plate
 * appearances to mean something. Shape matches the pattern cards: { sev: good|warn|bad|info, key, title, detail }.
 */
export const MIN_PA = 40;
export function flags(m, team) {
  if (!m || m.pa < MIN_PA || !team) return [];
  const out = [], d = (a, b) => (a != null && b != null ? a - b : null), f1 = (x) => (x == null ? "–" : `${Math.round(x)}%`);
  const add = (sev, key, title, detail) => out.push({ sev, key, title, detail });

  const k = d(m.kPct, team.kPct);
  if (k >= 6) add("bad", "k", "Strikes out more than the team", `${f1(m.kPct)} of his plate appearances end in a strikeout; the team's rate is ${f1(team.kPct)}.`);
  else if (k <= -5) add("good", "k", "Hard to strike out", `Strikes out in ${f1(m.kPct)} of plate appearances, against ${f1(team.kPct)} for the team.`);

  const bb = d(m.bbPct, team.bbPct);
  if (bb >= 3) add("good", "bb", "Draws walks", `Walks in ${f1(m.bbPct)} of plate appearances (team ${f1(team.bbPct)}).`);
  else if (bb <= -3) add("warn", "bb", "Rarely walks", `Walks in ${f1(m.bbPct)} of plate appearances (team ${f1(team.bbPct)}).`);

  const wh = d(m.whiffPct, team.whiffPct);
  if (wh >= 6) add("bad", "whiff", "Swings and misses a lot", `Misses on ${f1(m.whiffPct)} of his swings; the team misses ${f1(team.whiffPct)}.`);
  else if (wh <= -5) add("good", "whiff", "Puts the bat on the ball", `Misses on only ${f1(m.whiffPct)} of his swings (team ${f1(team.whiffPct)}).`);

  if (m.k >= 8 && m.klShare >= 40) add("warn", "kl", "Takes strike three", `${m.kl} of his ${m.k} strikeouts were called, not swinging (${f1(m.klShare)}).`);

  if (m.fpSwingPct != null && m.fpSwingPct <= 15) add("info", "fp", "Takes the first pitch", `Swings at the first pitch ${f1(m.fpSwingPct)} of the time. Pitchers threw him a first-pitch strike ${f1(m.fpStrikePct)} of the time.`);
  else if (m.fpSwingPct != null && m.fpSwingPct >= 45) add("info", "fp", "Swings early", `Swings at the first pitch ${f1(m.fpSwingPct)} of the time (team ${f1(team.fpSwingPct)}).`);

  const t2 = d(m.twoStrike.kPct, team.twoStrike.kPct);
  if (m.twoStrike.pa >= 20 && t2 >= 8) add("bad", "two", "Gives in with two strikes", `With two strikes he struck out ${f1(m.twoStrike.kPct)} of the time (team ${f1(team.twoStrike.kPct)}).`);
  else if (m.twoStrike.pa >= 20 && t2 <= -8) add("good", "two", "Tough with two strikes", `With two strikes he struck out only ${f1(m.twoStrike.kPct)} of the time (team ${f1(team.twoStrike.kPct)}) and fouled off ${m.twoStrike.foulsPerPA} pitches per plate appearance.`);

  if (m.batted.n >= 25) {
    const gb = d(m.batted.gbPct, team.batted.gbPct);
    if (gb >= 10) add("warn", "gb", "Lots of ground balls", `${f1(m.batted.gbPct)} of his balls in play were on the ground (team ${f1(team.batted.gbPct)}).`);
    const air = d((m.batted.ldPct || 0) + (m.batted.fbPct || 0), (team.batted.ldPct || 0) + (team.batted.fbPct || 0));
    if (air >= 10) add("good", "air", "Gets the ball in the air", `${f1((m.batted.ldPct || 0) + (m.batted.fbPct || 0))} of his balls in play were line drives or fly balls (team ${f1((team.batted.ldPct || 0) + (team.batted.fbPct || 0))}).`);
    if (m.batted.puPct >= 14) add("warn", "pu", "Pops up", `${f1(m.batted.puPct)} of his balls in play were pop-ups.`);
  }
  if (m.direction.n >= 25 && m.direction.oppoPct != null) {
    if (m.direction.oppoPct >= 33) add("good", "oppo", "Uses the whole field", `${f1(m.direction.oppoPct)} of his balls in play went the other way.`);
    else if (m.direction.gbPullPct >= 65 && m.batted.n >= 25) add("warn", "rollover", "Pulls his ground balls", `${f1(m.direction.gbPullPct)} of his ground balls went to the pull side.`);
  }
  const iso = d(m.iso, team.iso);
  if (m.ab >= 60 && iso >= 0.06) add("good", "power", "Hits for power", `Isolated power ${fmt3(m.iso)} (extra bases per at-bat beyond singles) against ${fmt3(team.iso)} for the team; ${m.hr} home runs.`);
  if (m.byCount.behind.pa >= 25 && team.byCount.behind.avg != null && m.byCount.behind.avg != null && m.byCount.behind.avg - team.byCount.behind.avg >= 0.05)
    add("good", "behind", "Still hits when behind", `Batted ${fmt3(m.byCount.behind.avg)} when the pitcher was ahead (team ${fmt3(team.byCount.behind.avg)}).`);
  if (m.byCount.ahead.pa >= 20 && team.byCount.ahead.avg != null && m.byCount.ahead.avg != null && team.byCount.ahead.avg - m.byCount.ahead.avg >= 0.07)
    add("warn", "ahead", "Doesn't cash in hitter's counts", `Batted ${fmt3(m.byCount.ahead.avg)} when ahead in the count (team ${fmt3(team.byCount.ahead.avg)}).`);

  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}
export const fmt3 = (x) => (x == null ? "–" : x.toFixed(3).replace(/^0/, ""));
