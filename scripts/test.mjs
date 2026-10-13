// Permission tests: who can see and change what. Runs the real api/ handlers on an in-memory Postgres.
//   node scripts/test.mjs
import assert from "node:assert/strict";
import { memoryDatabase, call } from "./_vercel.js";
import { seedDemo, createAdmin, DEV_CODES, DEMO_TEAM } from "./_seed.js";

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

console.log(process.exitCode ? "\nSome tests failed." : `\nAll ${passed} tests passed.`);
