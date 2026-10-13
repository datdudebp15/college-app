# Offseason College

Hitter development for college coaching staffs: a team roster, every at-bat graded on process, and a
morning report on who's trending up and who needs work. A separate product from Offseason (the pro app):
its own repo, Vercel project and database. "Offseason College" is a working name, set in `APP_NAME`
in `public/index.html`.

## How it's built
- `public/index.html` is the whole front end (plain HTML, CSS and JavaScript, Offseason's design system).
- `api/` holds Vercel functions on Neon Postgres. Tables are created on first use (`api/_db.js`).
- `api/_auth.js` has every permission rule in one place:
  - **coach**: the whole team (roster, every player, staff, sign-in codes)
  - **player**: only his own page
  - **admin** (Warren): every team, and can create teams
- Sign-in is an access code the coach hands out. Only its SHA-256 hash is stored; a new code replaces the old one.

## Local
`npm install`, then `npm run dev` serves http://localhost:3020 with the real API on a local Postgres kept in
`.devdb/` (git-ignored), with the fictional demo team reset at every start (codes print at startup).
`OC_TODAY=2026-04-15 npm run dev` pretends it's that date, to see an in-season week. `npm test` runs the tests.

## Demo data
The "Ridgeline State Owls" demo team and every player and coach on it are fictional (`scripts/_seed.js`).

## Where the data comes from
- **Rosters**: the school's own roster page (Team tab → Import roster). Works for sites built on WMT Digital.
- **Games**: ncaa.com scoreboards, box scores and play-by-play, through the open-source
  [ncaa-api](https://github.com/henrygd/ncaa-api) (3 requests a second on the public instance; set `NCAA_API_BASE`
  to run our own). Play-by-play carries every plate appearance's pitch sequence (ball, called strike, swinging
  strike, foul), result, batted-ball type and direction, and pitching changes. Everything is cached in our database.
- **TrackMan**: not connected yet. Pitch types, velocity, location and exit velocity arrive with API access.

## What a player sees
Up next (once the NCAA posts the schedule), the next opponent's likely starter and bullpen lined up against him,
his last game with every at-bat's pitch sequence and a short note, his season (what he does well, what to improve,
team averages for comparison) and year over year, including a transfer's seasons at his old school.
Numbers are computed in code (`api/_hitting.js`, `api/_opponent.js`); Claude only explains them (`api/_writer.js`,
`claude-opus-5-5`, a monthly cap per team, `OC_TEAM_MONTHLY_USD`, default $10). Without an API key the notes are
built from the same numbers in plain sentences.

## Setup on Vercel (once)
1. Vercel → Add New → Project → import this repo. Framework preset: Other. Deploy.
2. Storage → Create Database → Neon → connect it to this project, then Redeploy.
3. From your machine, with the Neon connection string:
   `DATABASE_URL="postgres://..." node scripts/setup.js admin "Warren Holzemer"` prints your admin code;
   `DATABASE_URL="postgres://..." node scripts/setup.js demo` creates the demo team and prints its codes.
   Keep them in `CODES.local.txt` (git-ignored).
4. Environment variables in Vercel: `ANTHROPIC_API_KEY` (the notes), `CRON_SECRET` (any long random string).
   In GitHub → Settings → Secrets: `APP_URL` (the Vercel address) and the same `CRON_SECRET`, for the nightly job.
5. First backfill for a team (a few minutes): `node scripts/sync.js <app url> <code> <team id>`, or the Team tab's
   "Update games now".

## Build order
1. Teams, roles, sign-in, roster, demo team (done)
2. Roster import from the school site (done)
3. NCAA games: player season, year over year, next game, next opponent, postgame notes (done)
4. TrackMan API: at-bat grading on pitch location and contact quality (waiting on access)
5. Morning coach view
6. Other connectors, opt-in per team (Trajekt, Blast, WHOOP, Rapsodo)
