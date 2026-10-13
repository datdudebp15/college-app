// Sportradar Global Baseball API v2 (Sportradar owns Synergy). Licensed NCAA Baseball schedules, scores,
// box-score stats, rosters and play-by-play timelines; no video or pitch tracking.
//   GET https://api.sportradar.com/baseball/{access}/v2/en/<feed>.json   header x-api-key: <key>
// The key lives in SPORTRADAR_API_KEY (or SYNERGY_API_KEY), set in .env.local locally and in Vercel in production.
// SPORTRADAR_ACCESS is "trial" (default) or "production", matching the key's plan. Trial keys allow about one
// request a second, so calls are spaced out.

const ACCESS = process.env.SPORTRADAR_ACCESS || "trial";
const BASE = `https://api.sportradar.com/baseball/${ACCESS}/v2/en`;
export const hasKey = () => !!(process.env.SPORTRADAR_API_KEY || process.env.SYNERGY_API_KEY);

let last = 0;
export async function sr(path) {
  const key = process.env.SPORTRADAR_API_KEY || process.env.SYNERGY_API_KEY;
  if (!key) throw Object.assign(new Error("no key"), { code: "no_sportradar_key" });
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const r = await fetch(`${BASE}/${path.replace(/^\//, "")}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("sportradar " + r.status), { code: "sportradar_denied", status: r.status });
  if (r.status === 429) throw Object.assign(new Error("sportradar rate limit"), { code: "sportradar_rate_limit", status: 429 });
  if (!r.ok) throw Object.assign(new Error("sportradar " + r.status), { code: "sportradar_error", status: r.status });
  return r.json();
}

export const competitions = () => sr("competitions.json");
export const competitionSeasons = (competitionId) => sr(`competitions/${encodeURIComponent(competitionId)}/seasons.json`);
export const seasonCompetitors = (seasonId) => sr(`seasons/${encodeURIComponent(seasonId)}/competitors.json`);
export const seasonSummaries = (seasonId) => sr(`seasons/${encodeURIComponent(seasonId)}/summaries.json`);
export const competitorProfile = (competitorId) => sr(`competitors/${encodeURIComponent(competitorId)}/profile.json`);
export const sportEventTimeline = (eventId) => sr(`sport_events/${encodeURIComponent(eventId)}/timeline.json`);
