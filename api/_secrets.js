import crypto from "node:crypto";

// Integration credentials (a team's TrackMan login, ...) are encrypted before they reach the database:
// AES-256-GCM with a key from INTEGRATIONS_KEY (32 random bytes, base64), set in Vercel and in .env.local.
// The database alone is useless without that key. Make one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

function key() {
  const k = Buffer.from(process.env.INTEGRATIONS_KEY || "", "base64");
  if (k.length !== 32) throw Object.assign(new Error("INTEGRATIONS_KEY missing or not 32 bytes"), { code: "no_integrations_key" });
  return k;
}
export const canEncrypt = () => { try { key(); return true; } catch { return false; } };

/** Any JSON value -> "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function seal(value) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), data].map((x) => (typeof x === "string" ? x : x.toString("base64url"))).join(".");
}
export function open(sealed) {
  const [v, iv, tag, data] = String(sealed || "").split(".");
  if (v !== "v1" || !iv || !tag || !data) throw Object.assign(new Error("bad secret"), { code: "bad_secret" });
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8"));
}
