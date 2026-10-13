import dns from "node:dns/promises";
import net from "node:net";

// Roster import from a school's own athletics site. NCAA sources don't publish rosters (ncaa.com has none and
// stats.ncaa.org refuses automated requests), but every school posts its roster publicly.
// Supported today: sites built on WMT Digital (e.g. hokiesports.com), which embed the roster as Nuxt page data.
// Only the fields the app uses are kept: name, number, position, class, bats/throws.

/** Fetches a roster page and returns { season, players: [{ sourceId, first, last, jersey, pos, posLabel, classYear, bats, throws, pitcher }] }. */
export async function fetchRoster(rawUrl) {
  const url = await safeUrl(rawUrl);
  const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000), headers: { "User-Agent": "OffseasonCollege/1.0 (roster import for the team's own coaching staff)" } });
  if (!r.ok) throw Object.assign(new Error("fetch " + r.status), { code: "fetch_failed", status: r.status });
  const html = await r.text();
  if (html.length > 8_000_000) throw Object.assign(new Error("too large"), { code: "too_large" });
  return parseRosterHtml(html);
}

/** Parses a WMT Digital roster page. Exported for tests. */
export function parseRosterHtml(html) {
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw Object.assign(new Error("unsupported site"), { code: "unsupported_site" });
  const A = JSON.parse(m[1]);
  const root = revive(A);

  // Roster entries (one per player per season) carry jersey, position and class; the same entry can appear more
  // than once in the page data, so merge copies by id.
  const entries = new Map(), seen = new Set();
  (function walk(x) {
    if (!x || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (!Array.isArray(x) && "jersey_number" in x && "class_level" in x && x.player && typeof x.player === "object") {
      const prev = entries.get(x.id);
      entries.set(x.id, prev ? { ...prev, ...x, profile_field_values: (x.profile_field_values || []).length ? x.profile_field_values : prev.profile_field_values } : x);
    }
    for (const k in x) walk(x[k]);
  })(root);
  if (!entries.size) throw Object.assign(new Error("no roster"), { code: "no_roster" });

  let season = null;
  const players = [...entries.values()].map((e) => {
    season ??= e.roster && e.roster.season && e.roster.season.name;
    const fields = [...(e.profile_field_values || []), ...(e.player.profile_field_values || [])];
    const bt = fields.find((v) => /bats\s*\/\s*throws/i.test(v?.profile_field?.name || ""));
    const [bats, throws] = String(bt?.value || "").toUpperCase().split("/").map((s) => s.trim());
    const posLabel = e.player_position?.abbreviation || "";
    return {
      sourceId: String(e.player_id ?? e.player.id),
      first: e.player.first_name || "", last: e.player.last_name || "",
      jersey: e.jersey_number_label ?? (e.jersey_number != null ? String(e.jersey_number) : null),
      pos: position(posLabel), posLabel,
      classYear: classYear(e.class_level?.name),
      bats: ["R", "L", "S", "B"].includes(bats) ? (bats === "B" ? "S" : bats) : null,
      throws: ["R", "L"].includes(throws) ? throws : null,
      pitcher: /^(P|RHP|LHP)$/i.test(posLabel),
    };
  }).filter((p) => p.first && p.last);
  return { season: season && /^\d{4}$/.test(season) ? Number(season) : null, players };
}

/* Nuxt 3 page data is "devalue" format: one flat array where objects point at other entries by index. */
function revive(A) {
  const memo = new Map();
  const R = (i) => {
    if (typeof i !== "number") return i;
    if (memo.has(i)) return memo.get(i);
    const v = A[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === "string" && /^(Reactive|ShallowReactive|Ref|ShallowRef|EmptyRef|Set|Map|Date|NuxtError)$/.test(v[0])) { const o = R(v[1]); memo.set(i, o); return o; }
      const o = []; memo.set(i, o); for (const x of v) o.push(R(x)); return o;
    }
    if (v && typeof v === "object") { const o = {}; memo.set(i, o); for (const k in v) o[k] = R(v[k]); return o; }
    return v;
  };
  return R(0);
}

// Two-way players are listed by where they hit (P/OF -> OF). Mixed infield/outfield becomes UT.
function position(p) {
  const s = String(p || "").toUpperCase().replace(/INF/g, "IF");
  const map = { "IF/OF": "UT", "OF/IF": "UT", "P/UT": "UT", "UT/P": "UT", "P/OF": "OF", "OF/P": "OF", "P/IF": "IF", "IF/P": "IF", "C/IF": "C", "IF/C": "C", "RHP": "P", "LHP": "P", "INF": "IF", "UTL": "UT" };
  if (map[s]) return map[s];
  const first = s.split("/")[0];
  return ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "OF", "IF", "UT", "DH", "P"].includes(first) ? first : null;
}
function classYear(name) {
  const s = String(name || "").toLowerCase();
  const rs = /redshirt|r-/.test(s) ? "RS " : "";
  if (/fresh/.test(s)) return rs + "Fr";
  if (/soph/.test(s)) return rs + "So";
  if (/junior/.test(s)) return rs + "Jr";
  if (/senior/.test(s)) return rs + "Sr";
  if (/grad|fifth|5th/.test(s)) return "Gr";
  return null;
}

/** Only public https pages, never addresses inside a private network. */
async function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw Object.assign(new Error("bad url"), { code: "bad_url" }); }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) throw Object.assign(new Error("bad url"), { code: "bad_url" });
  if (!/\/roster/i.test(u.pathname)) throw Object.assign(new Error("not a roster page"), { code: "not_roster" });
  if (net.isIP(u.hostname)) throw Object.assign(new Error("ip"), { code: "bad_url" });
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw Object.assign(new Error("private"), { code: "bad_url" });
  return u.toString();
}
function isPrivate(ip) {
  if (net.isIPv6(ip)) return /^(::1|::|f[cd]|fe80|::ffff:(10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
