// Local server: serves public/ and the real api/ handlers on an in-memory Postgres seeded with the
// fictional demo team. Sign in with the codes printed at startup. Nothing here touches the real database.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoryDatabase, call } from "./_vercel.js";
import { seedDemo, createAdmin, DEV_CODES } from "./_seed.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 3020;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

await memoryDatabase();
await seedDemo(DEV_CODES);
await createAdmin("Warren (local admin)", DEV_CODES.admin);

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const api = url.pathname.match(/^\/api\/([a-z][a-z0-9-]*)$/);
  if (api) {
    let raw = ""; for await (const c of req) raw += c;
    let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    const code = (req.headers.authorization || "").replace(/^Bearer /, "") || undefined;
    const r = await call(api[1], { method: req.method, query: Object.fromEntries(url.searchParams), body, code });
    res.writeHead(r.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(r.body));
  }
  const p = url.pathname === "/" ? "/index.html" : url.pathname;
  const f = path.join(root, "public", path.normalize(p));
  if (!f.startsWith(path.join(root, "public"))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(b);
  });
}).listen(PORT, () => {
  console.log(`college dev server on http://localhost:${PORT}`);
  console.log(`  admin  ${DEV_CODES.admin}\n  coach  ${DEV_CODES.coach}\n  player ${DEV_CODES.players.Avery} (Mason Avery)`);
});
