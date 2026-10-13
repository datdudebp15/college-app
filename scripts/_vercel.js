// Runs the api/ handlers the way Vercel does (req.query, parsed JSON req.body, res.status().json()),
// for the local dev server and the tests. Not used in production.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A local Postgres for the api/ code: in memory (tests), or kept in a folder (dev server). */
export async function memoryDatabase(dataDir) {
  globalThis.__pglite = dataDir ? new PGlite(dataDir) : new PGlite();
  await globalThis.__pglite.waitReady;
}

const cache = new Map();
async function load(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
  const f = path.join(root, "api", name + ".js");
  if (!fs.existsSync(f)) return null;
  if (!cache.has(name)) cache.set(name, (await import(pathToFileURL(f).href)).default);
  return cache.get(name);
}

/** Calls api/<name>.js directly. Returns { status, body }. */
export async function call(name, { method = "GET", query = {}, body, code, headers = {} } = {}) {
  const fn = await load(name);
  if (!fn) return { status: 404, body: { error: "no_route" } };
  const req = { method, query, body, headers: { ...headers, ...(code ? { authorization: "Bearer " + code } : {}) } };
  let status = 200, out = null;
  const res = { setHeader() {}, status(c) { status = c; return res; }, json(o) { out = o; return res; }, send(o) { out = o; return res; } };
  await fn(req, res);
  return { status, body: out };
}
