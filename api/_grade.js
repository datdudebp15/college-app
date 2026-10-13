// At-bat grading on process, not result: every pitch's swing decision (by location and count) plus the quality
// of contact. The code works out the facts and a score; Claude turns them into the grade and a sentence
// (api/_writer.js), and this rule-based grade stands in when Claude isn't available.
// With TrackMan (or demo) pitches we know location; with play-by-play only we know the sequence.

const ZX = 0.83, ZLO = 1.5, ZHI = 3.5;
/** heart / edge / chase / waste, like the attack zones teams use */
export function zoneOf(x, z) {
  if (x == null || z == null) return null;
  const ax = Math.abs(x);
  if (ax <= ZX - 0.33 && z >= ZLO + 0.33 && z <= ZHI - 0.33) return "heart";
  if (ax <= ZX + 0.12 && z >= ZLO - 0.12 && z <= ZHI + 0.12) return "edge";
  if (ax <= ZX + 0.6 && z >= ZLO - 0.6 && z <= ZHI + 0.6) return "chase";
  return "waste";
}
const inZone = (x, z) => x != null && Math.abs(x) <= ZX && z >= ZLO && z <= ZHI;
/** where it was from the hitter's side: "down and away", "up and in", "middle" */
export function spot(x, z, side) {
  if (x == null || z == null) return null;
  const inside = side === "L" ? x > 0.28 : x < -0.28, away = side === "L" ? x < -0.28 : x > 0.28;
  const v = z > 2.85 ? "up" : z < 2.15 ? "down" : "", h = inside ? "in" : away ? "away" : "";
  return [v, h].filter(Boolean).join(" and ") || "middle";
}
const SWING = new Set(["swinging_strike", "foul", "in_play"]);

/** One pitch -> { decision value, label } given the count before it. */
function judgePitch(p, side) {
  const zone = zoneOf(p.plate_x, p.plate_z), swung = SWING.has(p.call), two = p.strikes === 2, first = p.balls === 0 && p.strikes === 0;
  let v = 0, label = "";
  if (zone === "heart") { if (swung) { v = 1; label = "attacked a pitch over the heart"; } else { v = first ? -0.3 : two ? -1 : -0.8; label = two ? "took a hittable strike with two strikes" : "took a pitch over the heart"; } }
  else if (zone === "edge") { if (swung) { v = two ? 0.4 : 0.2; label = "swung at a strike on the edge"; } else { v = inZone(p.plate_x, p.plate_z) ? (two ? -0.8 : -0.1) : 0.2; label = inZone(p.plate_x, p.plate_z) ? (two ? "took strike three on the edge" : "took a strike on the edge") : "laid off a borderline pitch"; } }
  else if (zone === "chase") { if (swung) { v = two && p.call === "foul" ? -0.2 : -0.7; label = `chased ${p.pitch_type ? "a " + p.pitch_type.toLowerCase() : "a pitch"} ${spot(p.plate_x, p.plate_z, side)}`; } else { v = 0.6; label = "laid off a pitch just off the plate"; } }
  else if (zone === "waste") { if (swung) { v = -1; label = "swung at a pitch well out of the zone"; } else { v = 0.1; label = "took a ball"; } }
  if (p.call === "foul" && two) v += 0.15;
  if (p.call === "swinging_strike") { v -= zone === "heart" || zone === "edge" ? 0.45 : 0.2; if (!label.includes("chase") && !label.includes("out of the zone")) label = "swung through a strike"; }
  return { v, label, zone, swung };
}
/** Contact quality from exit velocity and launch angle. */
function judgeContact(ev, la) {
  if (ev == null) return null;
  if (ev >= 95 && la >= 8 && la <= 32) return { v: 1.6, label: `barreled it, ${Math.round(ev)} mph at ${Math.round(la)}°` };
  if (ev >= 95) return { v: 0.8, label: `hit it hard, ${Math.round(ev)} mph` };
  if (ev >= 85 && la >= 8 && la <= 30) return { v: 0.6, label: `solid contact, ${Math.round(ev)} mph at ${Math.round(la)}°` };
  if (la > 50) return { v: -0.5, label: "popped it up" };
  if (ev < 75) return { v: -0.3, label: `weak contact, ${Math.round(ev)} mph` };
  return { v: 0.1, label: `${Math.round(ev)} mph at ${Math.round(la)}°` };
}
export const LETTERS = ["A", "B", "C", "D", "F"];
// cutoffs set from a full simulated season so the mix is about 15% A, 25% B, 30% C, 20% D, 10% F
export const letter = (s) => (s >= 0.95 ? "A" : s >= 0.5 ? "B" : s >= 0.12 ? "C" : s >= -0.2 ? "D" : "F");

/**
 * Grade one plate appearance. pa: { outcome, seq, ... }; pitches: rows from the pitches table (may be empty).
 * Returns { grade, score, decisions, contact, facts: [..], pitches: [...] }.
 */
export function gradeAtBat(pa, pitches, side) {
  const facts = [];
  let dec = 0, n = 0, contact = null;
  if (pitches && pitches.length) {
    for (const p of pitches) {
      const j = judgePitch(p, side); dec += j.v; n++;
      if (Math.abs(j.v) >= 0.6) facts.push(`${p.balls}-${p.strikes}: ${j.label}`);
      if (p.call === "in_play") contact = judgeContact(p.ev, p.la);
    }
  } else {
    // play-by-play only: what the sequence and the result show
    const seq = pa.seq || "";
    for (let i = 0; i < seq.length; i++) {
      const c = seq[i], before = [...seq.slice(0, i)], strikes = Math.min(2, before.filter((x) => x === "K" || x === "S" || (x === "F")).length);
      if (c === "K" && strikes === 2) { dec -= 1; facts.push("took strike three"); }
      else if (c === "F" && strikes === 2) dec += 0.2;
      else if (c === "B") dec += 0.15;
      else if (c === "S") dec -= 0.25;
      n++;
    }
    if (/^(BB|IBB)$/.test(pa.outcome)) { dec += 0.8; facts.push("worked a walk"); }
    if (pa.in_play || pa.inPlay) contact = { GB: { v: -0.1, label: "on the ground" }, LD: { v: 0.9, label: "a line drive" }, FB: { v: 0.4, label: "in the air" }, PU: { v: -0.5, label: "popped it up" } }[pa.bb] || null;
  }
  const d = n ? dec / n : 0;
  const score = Math.round((d + (contact ? contact.v * 0.35 : 0)) * 100) / 100;
  if (contact) facts.push(contact.label);
  return { grade: letter(score), score, decisions: Math.round(d * 100) / 100, contact: contact && contact.v, facts: facts.slice(0, 5) };
}
/** A game's grade: the average of its at-bats. */
export function gradeGame(abs) {
  if (!abs.length) return null;
  const s = abs.reduce((t, a) => t + a.score, 0) / abs.length;
  return { grade: letter(s), score: Math.round(s * 100) / 100 };
}
