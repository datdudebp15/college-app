import crypto from "node:crypto";
import { nameKey } from "./_ncaa.js";

// TrackMan game CSV -> one record per pitch. Columns are read by header name (TrackMan's export has grown
// over the years and differs a little between Stadium and Portable), so missing columns are simply null.
// Names come as "Last, First"; pitch types and calls are reduced to a small fixed set the app uses.

export function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  text = String(text).replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] && r[0].trim()));
}

const TYPES = [
  [/^(four-?seam(fastball)?|fastball|ff|fourseamfastball)$/i, "Fastball"], [/^(sinker|two-?seam(fastball)?|si|ft|twoseamfastball)$/i, "Sinker"],
  [/^(cutter|fc)$/i, "Cutter"], [/^(sweeper|st)$/i, "Sweeper"], [/^(slider|sl)$/i, "Slider"], [/^(curveball|cu|kc|knucklecurve)$/i, "Curveball"],
  [/^(change-?up|ch)$/i, "Changeup"], [/^(splitter|fs|split-?finger)$/i, "Splitter"], [/^(knuckleball|kn)$/i, "Knuckleball"],
];
export function pitchType(tagged, auto) {
  for (const v of [tagged, auto]) {
    const s = String(v || "").trim();
    if (!s || /^(undefined|other|none)$/i.test(s)) continue;
    const hit = TYPES.find(([re]) => re.test(s.replace(/\s+/g, "")));
    if (hit) return hit[1];
  }
  return null;
}
export function pitchCall(c) {
  const s = String(c || "").toLowerCase().replace(/\s+/g, "");
  if (/^ball(called|indirt|intentional)?$/.test(s) || s === "pitchout") return "ball";
  if (s === "strikecalled") return "called_strike";
  if (s === "strikeswinging" || s === "swingingstrike") return "swinging_strike";
  if (s.startsWith("foulball") || s === "foul" || s === "foultip") return "foul";
  if (s === "inplay") return "in_play";
  if (s === "hitbypitch") return "hbp";
  return null;
}
const num = (v) => { if (v == null) return null; const s = String(v).trim(); if (!s || /^nan$/i.test(s)) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const int = (v) => { const n = num(v); return n == null ? null : Math.round(n); };
function isoDate(v) {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}
/** "Gibson, Ethan" -> { last, first, key } */
export function person(v) {
  const s = String(v || "").trim(); if (!s) return null;
  const [last, first = ""] = s.includes(",") ? s.split(",").map((x) => x.trim()) : [s.split(/\s+/).slice(1).join(" ") || s, s.split(/\s+/).length > 1 ? s.split(/\s+/)[0] : ""];
  return { last, first, key: nameKey(last, first) };
}

/** Rows of one TrackMan CSV -> pitch records. Rows that aren't pitches (no pitch call) are skipped. */
export function trackmanPitches(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n.toLowerCase()); if (i >= 0) return i; } return -1; };
  const C = {
    pitchNo: col("PitchNo"), date: col("Date", "GameDate"), time: col("Time"), pa: col("PAofInning"), pitchOfPa: col("PitchofPA"),
    pitcher: col("Pitcher"), pitcherId: col("PitcherId"), throws: col("PitcherThrows"), pitcherTeam: col("PitcherTeam"),
    batter: col("Batter"), batterId: col("BatterId"), side: col("BatterSide"), batterTeam: col("BatterTeam"),
    inning: col("Inning"), half: col("Top/Bottom", "TopBottom"), outs: col("Outs"), balls: col("Balls"), strikes: col("Strikes"),
    tagged: col("TaggedPitchType"), auto: col("AutoPitchType"), call: col("PitchCall"), korbb: col("KorBB"), hitType: col("TaggedHitType"), result: col("PlayResult"),
    velo: col("RelSpeed"), spin: col("SpinRate"), z: col("PlateLocHeight"), x: col("PlateLocSide"),
    ev: col("ExitSpeed"), la: col("Angle"), bearing: col("Bearing", "Direction"), distance: col("Distance"),
    gameId: col("GameID", "GameId"), uid: col("PitchUID"), home: col("HomeTeam"), away: col("AwayTeam"),
  };
  const g = (r, i) => (i >= 0 ? r[i] : undefined);
  const out = [];
  for (const r of rows.slice(1)) {
    const call = pitchCall(g(r, C.call));
    if (!call) continue;
    const date = isoDate(g(r, C.date)), gameId = String(g(r, C.gameId) || "").trim() || null, pitchNo = int(g(r, C.pitchNo));
    const uid = String(g(r, C.uid) || "").trim();
    const id = uid || crypto.createHash("sha1").update([gameId, date, g(r, C.time), pitchNo, g(r, C.batter), g(r, C.pitcher)].join("|")).digest("hex").slice(0, 24);
    const result = [g(r, C.korbb), g(r, C.result)].map((x) => String(x || "").trim()).find((x) => x && !/^(undefined)$/i.test(x)) || null;
    out.push({
      id: "tm-" + id, gameRef: gameId, date, time: String(g(r, C.time) || "").trim() || null, pitchNo,
      paOfInning: int(g(r, C.pa)), pitchOfPa: int(g(r, C.pitchOfPa)), inning: int(g(r, C.inning)), top: /^t/i.test(String(g(r, C.half) || "")),
      pitcher: person(g(r, C.pitcher)), pitcherThrows: /^l/i.test(String(g(r, C.throws) || "")) ? "L" : /^r/i.test(String(g(r, C.throws) || "")) ? "R" : null, pitcherTeam: String(g(r, C.pitcherTeam) || "").trim() || null,
      batter: person(g(r, C.batter)), batterSide: /^l/i.test(String(g(r, C.side) || "")) ? "L" : /^r/i.test(String(g(r, C.side) || "")) ? "R" : null, batterTeam: String(g(r, C.batterTeam) || "").trim() || null,
      homeTeam: String(g(r, C.home) || "").trim() || null, awayTeam: String(g(r, C.away) || "").trim() || null,
      balls: int(g(r, C.balls)), strikes: int(g(r, C.strikes)), pitchType: pitchType(g(r, C.tagged), g(r, C.auto)), call,
      velo: num(g(r, C.velo)), spin: int(g(r, C.spin)), plateX: num(g(r, C.x)), plateZ: num(g(r, C.z)),
      ev: num(g(r, C.ev)), la: num(g(r, C.la)), bearing: num(g(r, C.bearing)), distance: num(g(r, C.distance)),
      hitType: String(g(r, C.hitType) || "").trim() || null, result,
    });
  }
  return out;
}
