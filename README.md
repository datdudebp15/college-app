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
`npm install`, then `npm run dev` serves http://localhost:3020 with the real API on an in-memory Postgres
seeded with the fictional demo team (codes print at startup). `npm test` runs the permission tests.

## Demo data
The "Ridgeline State Owls" demo team and every player and coach on it are fictional (`scripts/_seed.js`).

## Setup on Vercel (once)
1. Vercel → Add New → Project → import this repo. Framework preset: Other. Deploy.
2. Storage → Create Database → Neon → connect it to this project, then Redeploy.
3. From your machine, with the Neon connection string:
   `DATABASE_URL="postgres://..." node scripts/setup.js admin "Warren Holzemer"` prints your admin code;
   `DATABASE_URL="postgres://..." node scripts/setup.js demo` creates the demo team and prints its codes.
   Keep them in `CODES.local.txt` (git-ignored).

## Build order
1. Teams, roles, sign-in, roster, demo team  ← this
2. Manual pitch charting and the rule-based at-bat grade
3. Morning coach view and player dashboard (strengths and weaknesses)
4. Claude at-bat summaries
5. Connectors, each opt-in per team (Trajekt, Blast, WHOOP, Rapsodo CSV; TrackMan and 6-4-3 later)
6. NCAA season data
7. Scouting report structure
