// Permission tests: who can see and change what. Runs the real api/ handlers on an in-memory Postgres.
//   node scripts/test.mjs
import assert from "node:assert/strict";
import { memoryDatabase, call } from "./_vercel.js";
import { seedDemo, createAdmin, DEV_CODES, DEMO_TEAM } from "./_seed.js";
import { parseRosterHtml, fetchRoster } from "../api/_roster.js";

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

console.log(process.exitCode ? "\nSome tests failed." : `\nAll ${passed} tests passed.`);
