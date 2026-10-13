// Permission tests: who can see and change what. Runs the real api/ handlers on an in-memory Postgres.
//   node scripts/test.mjs
import assert from "node:assert/strict";
import { memoryDatabase, call } from "./_vercel.js";
import { seedDemo, createAdmin, DEV_CODES, DEMO_TEAM } from "./_seed.js";
import { parseRosterHtml, fetchRoster } from "../api/_roster.js";
import { parsePA, parseGame, nameKey } from "../api/_ncaa.js";
import { metrics, flags } from "../api/_hitting.js";
import { matchup, likelyStarter } from "../api/_opponent.js";

await memoryDatabase();
await seedDemo(DEV_CODES);
const ADMIN = await createAdmin("Admin", DEV_CODES.admin);
const COACH = DEV_CODES.coach, AVERY = DEV_CODES.players.Avery, KOWAL = DEV_CODES.players.Kowalczyk;
const T = DEMO_TEAM.id;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

// A second team, made by the admin, to check teams can't see each other.
const made = await call("team", { method: "POST", code: ADMIN, body: { name: "Other Test College", season: 2026, coachName: "Other Coach" } });
const OTHER = made.body.team.id, OTHER_COACH = made.body.code;

console.log("sign-in");
await test("no code is refused", async () => assert.equal((await call("me")).status, 401));
await test("a wrong code is refused", async () => assert.equal((await call("me", { code: "WRONG-CODE1" })).status, 401));
await test("codes ignore case and dashes", async () => assert.equal((await call("me", { code: COACH.toLowerCase().replace("-", " ") })).status, 200));

console.log("coach");
await test("coach sees his team", async () => {
  const r = await call("me", { code: COACH });
  assert.deepEqual(r.body.teams.map((t) => [t.id, t.role]), [[T, "coach"]]);
});
await test("coach sees the whole roster with sign-in status and staff", async () => {
  const r = await call("team", { code: COACH, query: { id: T } });
  assert.equal(r.status, 200);
  assert.equal(r.body.players.length, 12);
  assert.equal(r.body.players.find((p) => p.last === "Avery").access, "invited");
  assert.equal(r.body.players.find((p) => p.last === "Varela").access, "none");
  assert.equal(r.body.staff.length, 1);
});
await test("coach cannot see another team", async () => assert.equal((await call("team", { code: COACH, query: { id: OTHER } })).status, 404));
await test("coach cannot add a player to another team", async () =>
  assert.equal((await call("players", { method: "POST", code: COACH, query: { team: OTHER }, body: { first: "X", last: "Y" } })).status, 404));
await test("coach cannot create teams", async () =>
  assert.equal((await call("team", { method: "POST", code: COACH, body: { name: "X", season: 2026, coachName: "Y" } })).status, 403));
let added;
await test("coach adds, edits and removes a player", async () => {
  const a = await call("players", { method: "POST", code: COACH, query: { team: T }, body: { first: "Test", last: "Walkon", pos: "of", bats: "L", throws: "L", classYear: "Fr", jersey: "44" } });
  assert.equal(a.status, 200); added = a.body.player;
  assert.equal(added.pos, "OF");
  const e = await call("players", { method: "PATCH", code: COACH, query: { team: T, id: added.id }, body: { jersey: "45" } });
  assert.equal(e.body.player.jersey, "45"); assert.equal(e.body.player.bats, "L");
});
let walkonCode;
await test("coach gives a player a code, and the player can sign in", async () => {
  const r = await call("access", { method: "POST", code: COACH, query: { team: T }, body: { player: added.id } });
  walkonCode = r.body.code;
  const me = await call("me", { code: walkonCode });
  assert.deepEqual(me.body.teams.map((t) => [t.role, t.playerId]), [["player", added.id]]);
});
await test("a new code replaces the old one", async () => {
  const r = await call("access", { method: "POST", code: COACH, query: { team: T }, body: { player: added.id } });
  assert.equal((await call("me", { code: walkonCode })).status, 401);
  assert.equal((await call("me", { code: r.body.code })).status, 200);
  walkonCode = r.body.code;
});
await test("removing a player ends his sign-in", async () => {
  assert.equal((await call("players", { method: "DELETE", code: COACH, query: { team: T, id: added.id } })).status, 200);
  assert.equal((await call("me", { code: walkonCode })).status, 401);
  assert.equal((await call("team", { code: COACH, query: { id: T } })).body.players.length, 12);
});
await test("coach adds a coach; the last coach can't be removed", async () => {
  const r = await call("access", { method: "POST", code: COACH, query: { team: T }, body: { coach: "Asst. Coach Test" } });
  const asst = r.body.user;
  assert.equal((await call("team", { code: r.body.code, query: { id: T } })).body.players.length, 12);
  assert.equal((await call("access", { method: "DELETE", code: COACH, query: { team: T, user: asst } })).status, 200);
  const me = (await call("team", { code: COACH, query: { id: T } })).body.staff[0].id;
  assert.equal((await call("access", { method: "DELETE", code: COACH, query: { team: T, user: me } })).status, 409);
});

console.log("player");
await test("player sees only himself", async () => {
  const r = await call("team", { code: AVERY, query: { id: T } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.players.map((p) => p.last), ["Avery"]);
  assert.equal(r.body.staff, null);
  assert.equal(r.body.me.role, "player");
});
await test("another player sees only himself too", async () => {
  const r = await call("team", { code: KOWAL, query: { id: T } });
  assert.deepEqual(r.body.players.map((p) => p.last), ["Kowalczyk"]);
});
await test("player cannot change the roster", async () => {
  assert.equal((await call("players", { method: "POST", code: AVERY, query: { team: T }, body: { first: "A", last: "B" } })).status, 403);
  const avery = (await call("team", { code: AVERY, query: { id: T } })).body.players[0];
  assert.equal((await call("players", { method: "PATCH", code: AVERY, query: { team: T, id: avery.id }, body: { jersey: "99" } })).status, 403);
});
await test("player cannot hand out codes or rename the team", async () => {
  assert.equal((await call("access", { method: "POST", code: AVERY, query: { team: T }, body: { coach: "Me" } })).status, 403);
  assert.equal((await call("team", { method: "PATCH", code: AVERY, query: { id: T }, body: { name: "Hacked" } })).status, 403);
});
await test("player cannot see another team", async () => assert.equal((await call("team", { code: AVERY, query: { id: OTHER } })).status, 404));

console.log("admin");
await test("admin sees every team as coach", async () => {
  const r = await call("me", { code: ADMIN });
  assert.equal(r.body.user.admin, true);
  assert.deepEqual(r.body.teams.map((t) => t.id).sort(), [OTHER, T].sort());
  assert.equal((await call("team", { code: ADMIN, query: { id: T } })).body.players.length, 12);
});
await test("the other team's coach sees only his own team", async () => {
  const r = await call("me", { code: OTHER_COACH });
  assert.deepEqual(r.body.teams.map((t) => t.id), [OTHER]);
});

console.log("admin preview");
await test("admin previewing as a player sees only that player", async () => {
  const avery = (await call("team", { code: AVERY, query: { id: T } })).body.players[0];
  const r = await call("team", { code: ADMIN, query: { id: T }, headers: { "x-view-as": "player:" + avery.id } });
  assert.equal(r.body.me.role, "player");
  assert.deepEqual(r.body.players.map((p) => p.id), [avery.id]);
  assert.equal(r.body.staff, null);
  const other = (await call("team", { code: COACH, query: { id: T } })).body.players.find((p) => p.last === "Varela");
  assert.equal((await call("player", { code: ADMIN, query: { team: T, id: other.id }, headers: { "x-view-as": "player:" + avery.id } })).status, 404, "not a teammate's page");
});
await test("admin previewing as a coach sees the roster but can't change anything", async () => {
  const r = await call("team", { code: ADMIN, query: { id: T }, headers: { "x-view-as": "coach" } });
  assert.equal(r.body.me.role, "coach"); assert.equal(r.body.players.length, 12);
  assert.equal((await call("players", { method: "POST", code: ADMIN, query: { team: T }, headers: { "x-view-as": "coach" }, body: { first: "A", last: "B" } })).status, 403);
  assert.equal((await call("access", { method: "POST", code: ADMIN, query: { team: T }, headers: { "x-view-as": "coach" }, body: { coach: "X" } })).status, 403);
});
await test("the preview header does nothing for coaches and players", async () => {
  const r = await call("team", { code: AVERY, query: { id: T }, headers: { "x-view-as": "coach" } });
  assert.equal(r.body.me.role, "player"); assert.equal(r.body.players.length, 1);
  const c = await call("players", { method: "POST", code: COACH, query: { team: T }, headers: { "x-view-as": "coach" }, body: { first: "Still", last: "Works" } });
  assert.equal(c.status, 200);
  await call("players", { method: "DELETE", code: COACH, query: { team: T, id: c.body.player.id } });
});
await test("previewing a player from another team fails", async () => {
  const avery = (await call("team", { code: AVERY, query: { id: T } })).body.players[0];
  assert.equal((await call("team", { code: ADMIN, query: { id: OTHER }, headers: { "x-view-as": "player:" + avery.id } })).status, 404);
});

console.log("roster import");
// A fictional roster page in the WMT Digital format (Nuxt "devalue" data: one flat array, objects point at entries by index).
function nuxtPage(root) {
  const A = []; const enc = (v) => { const i = A.length; A.push(null);
    A[i] = Array.isArray(v) ? v.map(enc) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v; return i; };
  enc(root);
  return `<html><body><script type="application/json" data-nuxt-data="nuxt-app" id="__NUXT_DATA__">${JSON.stringify(A)}</script></body></html>`;
}
const season = { id: 1, name: "2027" };
const entry = (id, first, last, jersey, pos, cls, bt) => ({ id, player_id: 100 + id, jersey_number: jersey, jersey_number_label: String(jersey), class_level: { name: cls },
  player_position: { abbreviation: pos }, roster: { season }, profile_field_values: [],
  player: { id: 100 + id, first_name: first, last_name: last, profile_field_values: bt ? [{ profile_field: { name: "Bats/Throws" }, value: bt }] : [] } });
const page = nuxtPage({ data: { roster: { players: [
  entry(1, "Test", "Shortstop", 6, "IF", "Redshirt Sophomore", "R/R"),
  entry(2, "Test", "Twoway", 19, "P/OF", "Freshman", "L/L"),
  entry(3, "Test", "Arm", 31, "P", "Junior", "R/R"),
  entry(4, "Test", "Catcher", 9, "C/INF", "Fifth Year", "S/R"),
] }, again: [entry(1, "Test", "Shortstop", 6, "IF", "Redshirt Sophomore", "R/R")] } });
await test("reads players, positions, classes and bats/throws", async () => {
  const r = parseRosterHtml(page);
  assert.equal(r.season, 2027);
  assert.equal(r.players.length, 4, "the same player twice in the page data counts once");
  const ss = r.players.find((p) => p.last === "Shortstop");
  assert.deepEqual([ss.jersey, ss.pos, ss.classYear, ss.bats, ss.throws, ss.pitcher], ["6", "IF", "RS So", "R", "R", false]);
  const tw = r.players.find((p) => p.last === "Twoway");
  assert.deepEqual([tw.pos, tw.pitcher, tw.bats], ["OF", false, "L"], "two-way players are hitters");
  assert.equal(r.players.find((p) => p.last === "Arm").pitcher, true);
  const c = r.players.find((p) => p.last === "Catcher");
  assert.deepEqual([c.pos, c.classYear, c.bats], ["C", "Gr", "S"]);
});
await test("pages from unsupported sites are refused", async () => assert.throws(() => parseRosterHtml("<html></html>"), (e) => e.code === "unsupported_site"));
await test("only public https roster pages are fetched", async () => {
  for (const [u, code] of [["http://hokiesports.com/sports/baseball/roster", "bad_url"], ["https://localhost/roster", "bad_url"], ["https://127.0.0.1/roster", "bad_url"],
    ["https://user:pw@example.com/roster", "bad_url"], ["https://hokiesports.com/sports/baseball/schedule", "not_roster"], ["not a url", "bad_url"]])
    await assert.rejects(fetchRoster(u), (e) => e.code === code, u);
});
await test("players cannot import a roster", async () =>
  assert.equal((await call("roster", { method: "POST", code: AVERY, query: { team: T }, body: { url: "https://example.com/roster" } })).status, 403));

console.log("play-by-play");
// Made-up lines in ncaa.com's format.
await test("reads results, pitch sequences, batted balls and direction", async () => {
  const a = parsePA("Testman,Jay struck out looking (1-2 BKFFK).");
  assert.deepEqual([a.last, a.first, a.outcome, a.seq, a.pitches, a.swings, a.whiffs, a.called, a.inPlay, a.ab], ["Testman", "Jay", "KL", "BKFFK", 5, 2, 0, 2, false, true]);
  const b = parsePA("Testman,Jay flied out to lf (2-1 KBB).");
  assert.deepEqual([b.outcome, b.pitches, b.swings, b.bb, b.field, b.balls, b.strikes], ["FO", 4, 1, "FB", "L", 2, 1]);
  const c = parsePA("Sample,Ray grounded out, 2b to 1b (0-1 K); Other,Guy advanced to third base.");
  assert.deepEqual([c.outcome, c.bb, c.field], ["GO", "GB", "R"]);
  assert.equal(parsePA("Sample,Ray walked (3-1 BKBBB).").ab, false);
  assert.equal(parsePA("Sample,Ray singled up the middle (0-0).").field, "C");
  assert.equal(parsePA("Sample,Ray struck out swinging (2-2 BSSNS).").seq, "BSSS", "clock violations aren't pitches");
  assert.equal(parsePA("Mound visit (VT)"), null);
  assert.equal(parsePA("Previous PA: HBP result after 1-2 count (KBF)"), null);
  assert.equal(parsePA("Sample,Ray stole second base."), null);
});
await test("tracks who pitched to whom, starters first", async () => {
  const pbp = { teams: [{ teamId: "1", seoname: "home-u", nameShort: "Home" }, { teamId: "2", seoname: "away-u", nameShort: "Away" }],
    periods: [{ periodNumber: 1, playbyplayStats: [
      { teamId: 2, plays: [{ playText: "Lead,Off flied out to cf (0-0)." }] },
      { teamId: 1, plays: [{ playText: "First,Bat struck out swinging (0-2 SSS)." }] },
      { teamId: 1, plays: [{ playText: "AWAY pitching change: Reliever,Rob replaces Starter,Sam." }] },
      { teamId: 1, plays: [{ playText: "Second,Bat walked (3-0 BBBB)." }] } ] }] };
  const g = parseGame(null, pbp);
  assert.deepEqual(g.pas.map((p) => [p.batSeo, p.pitchSeo, p.pitcher]), [["away-u", "home-u", null], ["home-u", "away-u", "starter|s"], ["home-u", "away-u", "reliever|r"]]);
  const s = g.pitchers.find((p) => p.name === "starter|s");
  assert.deepEqual([s.started, s.bf, s.k, s.outs], [true, 1, 1, 1]);
});
await test("names match across sources", async () => assert.equal(nameKey("TarpleyJr", "Derrick"), nameKey("Tarpley", "Derrick")));
await test("every scorer's name style reads the same", async () => {
  for (const line of ["Gibson,Ethan singled (0-0).", "E. Gibson singled (0-0).", "GIBSON, E. singled (0-0).", "Gibson, E singled (0-0)."]) assert.equal(parsePA(line).key, "gibson|e", line);
  assert.equal(parsePA("Gibson singled (0-0).").key, "gibson|");
  const noCount = parsePA("Minnick, T grounded out to ss, RBI; Neises, T advanced to second.");
  assert.deepEqual([noCount.key, noCount.outcome, noCount.seq, noCount.pitches], ["minnick|t", "GO", null, null]);
  assert.equal(parsePA("W. Holzemer pinch hit for C. Grady."), null);
  assert.equal(parsePA("Ellis, M advanced to third on a wild pitch; Yunger, T scored on a wild pitch."), null);
});
await test("\"A to p for B\" pitching changes, with teams from the box score", async () => {
  const box = { teams: [{ teamId: "1", seoname: "home-u" }, { teamId: "2", seoname: "away-u" }], teamBoxscore: [
    { teamId: 1, playerStats: [{ firstName: "Cal", lastName: "Grady" }, { firstName: "Sam", lastName: "Starter", pitcherStats: {} }, { firstName: "Rob", lastName: "Relief", pitcherStats: {} }] },
    { teamId: 2, playerStats: [{ firstName: "Tom", lastName: "Yunger" }, { firstName: "Al", lastName: "Arm", pitcherStats: {} }] }] };
  const pbp = { periods: [{ periodNumber: 1, playbyplayStats: [
    { teamId: 1, plays: [{ playText: "C. Grady struck out swinging (1-2 BKFS)." }] },
    { teamId: 1, plays: [{ playText: "R. Relief to p for Starter." }] },
    { teamId: 2, plays: [{ playText: "Yunger, T doubled to left center (0-1 K)." }] } ] }] };
  const g = parseGame(box, pbp);
  assert.deepEqual(g.pas.map((p) => [p.key, p.batSeo, p.pitcher, p.pitcherName]), [["grady|c", "home-u", "arm|a", "Al Arm"], ["yunger|t", "away-u", "relief|r", "Rob Relief"]]);
  assert.equal(g.pitchers.find((p) => p.name === "arm|a").started, true);
});

console.log("hitting numbers");
const P = (o) => ({ outcome: "GO", seq: "", balls: 0, strikes: 0, pitches: 1, swings: 1, whiffs: 0, fouls: 0, called: 0, in_play: true, hit: false, ab: true, bb: "GB", field: "L", ...o });
await test("slash line, rates and first-pitch numbers", async () => {
  const pas = [P({ outcome: "1B", hit: true, bb: "LD" }), P({ outcome: "HR", hit: true, bb: "FB", seq: "B", pitches: 2 }), P({ outcome: "BB", ab: false, in_play: false, seq: "BBBB", pitches: 4, swings: 0, bb: null, field: null }),
    P({ outcome: "KS", in_play: false, seq: "KSS", pitches: 3, swings: 2, whiffs: 2, called: 1, strikes: 2, bb: null, field: null })];
  const m = metrics(pas, "R");
  assert.deepEqual([m.pa, m.ab, m.h, m.avg, m.obp, m.slg], [4, 3, 2, 0.667, 0.75, 1.667]);
  assert.equal(m.kPct, 25); assert.equal(m.fpSwingPct, 25, "only the single was swung at on the first pitch"); assert.equal(m.whiffPct, 50);
  assert.equal(m.twoStrike.pa, 1);
});
await test("flags compare him to his team, and need enough plate appearances", async () => {
  const team = metrics(Array.from({ length: 200 }, (_, i) => P(i % 5 === 0 ? { outcome: "KS", in_play: false, seq: "SSS", pitches: 3, swings: 3, whiffs: 3, bb: null, field: null } : {})), null);
  const lots = Array.from({ length: 60 }, (_, i) => P(i % 2 === 0 ? { outcome: "KS", in_play: false, seq: "SSS", pitches: 3, swings: 3, whiffs: 3, bb: null, field: null } : {}));
  assert.ok(flags(metrics(lots, "R"), team).some((f) => f.key === "k" && f.sev === "bad"));
  assert.deepEqual(flags(metrics(lots.slice(0, 20), "R"), team), []);
});
await test("matchup notes come from both sides' numbers", async () => {
  const notes = matchup({ fpStrikePct: 70, whiffPct: 30, kLookingShare: 10, gbPct: 40, bip: 30, bbPct: 5, pitchesPerBF: 3.8 }, { fpSwingPct: 10, whiffPct: 25, klShare: 0, k: 3, batted: { gbPct: 30 } });
  assert.equal(notes.length, 2);
  assert.match(notes[0], /first-pitch strike 70%/);
});
await test("likely starter: whoever started their last game on that weekday", async () => {
  const staff = [{ name: "Fri Guy", starts: 3, last: "2026-04-10", recent: [{ date: "2026-04-10", started: true }] },
    { name: "Sat Guy", starts: 3, last: "2026-04-11", recent: [{ date: "2026-04-11", started: true }] }];
  assert.equal(likelyStarter(staff, "2026-04-18").name, "Sat Guy");
});

console.log(process.exitCode ? "\nSome tests failed." : `\nAll ${passed} tests passed.`);
