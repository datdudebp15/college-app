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
  // Where a player came from (e.g. "site" = the school's roster page) and his id there, so re-imports update him.
  `ALTER TABLE players ADD COLUMN IF NOT EXISTS source text`,
  `ALTER TABLE players ADD COLUMN IF NOT EXISTS source_id text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS players_source ON players (team_id, source, source_id) WHERE source_id IS NOT NULL`,
  `ALTER TABLE teams ADD COLUMN IF NOT EXISTS roster_url text`,
  `ALTER TABLE teams ADD COLUMN IF NOT EXISTS ncaa_seo text`,
  `ALTER TABLE players ADD COLUMN IF NOT EXISTS prev_school text`,

  // NCAA data, shared by every team: each date's scoreboard and each game is fetched once.
  `CREATE TABLE IF NOT EXISTS ncaa_dates (date text PRIMARY KEY, fetched_at timestamptz NOT NULL DEFAULT now(), games int NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ncaa_games (
    id text PRIMARY KEY, date text NOT NULL, season int NOT NULL, epoch bigint, state text, time text,
    home_seo text NOT NULL, home_name text, home_score int, away_seo text NOT NULL, away_name text, away_score int
  )`,
  `CREATE INDEX IF NOT EXISTS ncaa_games_home ON ncaa_games (home_seo, date)`,
  `CREATE INDEX IF NOT EXISTS ncaa_games_away ON ncaa_games (away_seo, date)`,
  `CREATE TABLE IF NOT EXISTS ncaa_game_data (game_id text PRIMARY KEY, box jsonb, pbp jsonb, parser_v int NOT NULL DEFAULT 0, fetched_at timestamptz NOT NULL DEFAULT now())`,
  // one row per plate appearance, parsed from the play-by-play
  `CREATE TABLE IF NOT EXISTS ncaa_pas (
    game_id text NOT NULL, idx int NOT NULL, inning int, bat_seo text, pitch_seo text, batter_key text, batter text, pitcher text,
    outcome text, seq text, balls int, strikes int, pitches int, swings int, whiffs int, fouls int, called int,
    in_play boolean, hit boolean, ab boolean, bb text, field text, text text,
    PRIMARY KEY (game_id, idx)
  )`,
  `ALTER TABLE ncaa_pas ADD COLUMN IF NOT EXISTS pitcher_name text`,
  `CREATE INDEX IF NOT EXISTS ncaa_pas_batter ON ncaa_pas (bat_seo, batter_key)`,
  `CREATE INDEX IF NOT EXISTS ncaa_pas_pitcher ON ncaa_pas (pitch_seo, pitcher)`,
  `CREATE TABLE IF NOT EXISTS ncaa_pitch_lines (
    game_id text NOT NULL, seo text NOT NULL, name text NOT NULL, started boolean, bf int, outs int, h int, bb int, k int, hbp int, hr int, pitches int,
    PRIMARY KEY (game_id, seo, name)
  )`,
  `ALTER TABLE ncaa_pitch_lines ADD COLUMN IF NOT EXISTS display text`,
  // Claude's write-ups: kind = season | postgame | opponent; key = season year, game id, or opponent+date
  `CREATE TABLE IF NOT EXISTS notes (
    player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE, kind text NOT NULL, key text NOT NULL,
    data jsonb NOT NULL, source_hash text, model text, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (player_id, kind, key)
  )`,
  `CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
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
