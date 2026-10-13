import { neon } from "@neondatabase/serverless";

// Neon's Vercel integration sets DATABASE_URL; older setups use POSTGRES_URL.
// The local dev server and tests put an in-memory Postgres (PGlite) on globalThis.__pglite instead.
const URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const neonSql = URL ? neon(URL) : null;

export const hasDatabase = () => !!(globalThis.__pglite || neonSql);

/** One parameterized statement ($1, $2, ...). Returns the rows. */
export async function query(text, params = []) {
  if (globalThis.__pglite) return (await globalThis.__pglite.query(text, params)).rows;
  if (!neonSql) throw Object.assign(new Error("no database"), { code: "no_database" });
  return neonSql.query(text, params);
}
export const one = async (text, params) => (await query(text, params))[0] || null;

// Tables. Each statement runs on its own (Neon's HTTP driver takes one statement per call).
// Later PRs add pitches, at-bats and grades; everything hangs off teams and players.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS teams (
    id text PRIMARY KEY,
    name text NOT NULL,
    short_name text,
    season int NOT NULL,
    demo boolean NOT NULL DEFAULT false,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    name text NOT NULL,
    code_hash text UNIQUE,
    is_admin boolean NOT NULL DEFAULT false,
    last_seen timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS players (
    id text PRIMARY KEY,
    team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    first_name text NOT NULL,
    last_name text NOT NULL,
    jersey text,
    pos text,
    bats text CHECK (bats IN ('R','L','S')),
    throws text CHECK (throws IN ('R','L')),
    class_year text,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS players_team ON players (team_id)`,
  // role: coach (sees and manages the whole team) or player (sees only player_id).
  `CREATE TABLE IF NOT EXISTS members (
    team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('coach','player')),
    player_id text REFERENCES players(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id),
    CHECK ((role = 'player') = (player_id IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS members_player ON members (player_id) WHERE player_id IS NOT NULL`,
];

let ready;
export function ensureSchema() {
  ready ??= (async () => { for (const s of SCHEMA) await query(s); })().catch((e) => { ready = null; throw e; });
  return ready;
}
