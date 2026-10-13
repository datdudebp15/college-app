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
  // Pitch tracking (TrackMan, Synergy, or the simulated demo season): one row per pitch, linked to its plate
  // appearance by game and index. video_url is a per-pitch clip when the source provides one.
  `CREATE TABLE IF NOT EXISTS pitches (
    id text PRIMARY KEY, game_id text NOT NULL, pa_idx int, pitch_no int, date text, season int, inning int,
    bat_seo text, pitch_seo text, batter_key text, pitcher_key text, batter_side text, pitcher_throws text,
    balls int, strikes int, pitch_type text, velo real, spin int, plate_x real, plate_z real, call text,
    ev real, la real, bearing real, distance real, result text, video_url text, source text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS pitches_batter ON pitches (bat_seo, batter_key)`,
  `CREATE INDEX IF NOT EXISTS pitches_pitcher ON pitches (pitch_seo, pitcher_key)`,
  `CREATE INDEX IF NOT EXISTS pitches_game ON pitches (game_id, pa_idx)`,
  `ALTER TABLE pitches ADD COLUMN IF NOT EXISTS pa_ref text`,
  `ALTER TABLE pitches ADD COLUMN IF NOT EXISTS hit_type text`,
  `ALTER TABLE pitches ADD COLUMN IF NOT EXISTS batter_name text`,
  `ALTER TABLE pitches ADD COLUMN IF NOT EXISTS pitcher_name text`,
  // Season stats loaded from a report (e.g. a TrackMan season summary) rather than built from play-by-play.
  // line: the season line; by_pitch: rows per pitch type. Shown alongside play-by-play seasons.
  `CREATE TABLE IF NOT EXISTS player_seasons (
    player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE, season int NOT NULL, school text NOT NULL,
    source text NOT NULL, line jsonb NOT NULL, by_pitch jsonb, note text, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (player_id, season, school)
  )`,
  `ALTER TABLE players ADD COLUMN IF NOT EXISTS real_person boolean NOT NULL DEFAULT false`,
  // A team's connected data sources. Secrets (logins) are sealed with INTEGRATIONS_KEY; config holds the rest.
  `CREATE TABLE IF NOT EXISTS integrations (
    team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE, source text NOT NULL,
    config jsonb NOT NULL DEFAULT '{}'::jsonb, secret text, enabled boolean NOT NULL DEFAULT true,
    status text, last_run_at timestamptz, last_ok_at timestamptz, last_error text, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, source)
  )`,
  `CREATE TABLE IF NOT EXISTS trackman_files (
    team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE, path text NOT NULL, size bigint, imported_at timestamptz,
    pitches int, error text, PRIMARY KEY (team_id, path)
  )`,
  // TrackMan live feed (Portable B1 / Stadium): one secret token per team in the webhook URLs, and every
  // message stored raw on arrival (TrackMan sends each once, with no retries). Parsed into pitches later.
  `CREATE TABLE IF NOT EXISTS trackman_feeds (
    team_id text PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE, token text UNIQUE NOT NULL,
    validated_at timestamptz, last_event_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS trackman_events (
    id bigserial PRIMARY KEY, team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE, kind text NOT NULL,
    session_id text, play_id text, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS trackman_events_session ON trackman_events (team_id, session_id, received_at)`,
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
