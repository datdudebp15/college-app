// One-time setup against the real database. Run from your machine with the Neon connection string:
//   DATABASE_URL="postgres://..." node scripts/setup.js admin "Warren Holzemer"   -> prints your admin code
//   DATABASE_URL="postgres://..." node scripts/setup.js demo                      -> (re)creates the fictional demo team, prints its codes
// Codes are printed once and only their hashes are stored. Save them in CODES.local.txt (git-ignored).
import { seedDemo, createAdmin } from "./_seed.js";

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  console.error("Set DATABASE_URL to the Neon connection string first.");
  process.exit(1);
}
const [cmd, name] = process.argv.slice(2);
if (cmd === "admin") {
  console.log(`Admin code for ${name || "Admin"}: ${await createAdmin(name || "Admin")}`);
} else if (cmd === "demo") {
  const c = await seedDemo();
  console.log(`Demo coach (Coach Dale Hartwell): ${c.coach}`);
  for (const [k, v] of Object.entries(c.players)) console.log(`Demo player ${k}: ${v}`);
} else {
  console.error('Usage: node scripts/setup.js admin "Your Name" | demo');
  process.exit(1);
}
