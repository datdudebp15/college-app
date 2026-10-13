// The fictional league the demo team plays in. Every school and player here is made up; ids start with
// "demo-" so they can never collide with real NCAA teams, and the NCAA sync never fetches them.
export const DEMO_LEAGUE = [
  { seo: "demo-ridgeline", name: "Ridgeline State", mascot: "Owls" },
  { seo: "demo-harbor", name: "Harbor City", mascot: "Gulls" },
  { seo: "demo-pine", name: "Pine Hollow Tech", mascot: "Foxes" },
  { seo: "demo-cedar", name: "Cedar Bluff", mascot: "Rams" },
  { seo: "demo-marrow", name: "Marrow Bay", mascot: "Pelicans" },
  { seo: "demo-ashgrove", name: "Ashgrove", mascot: "Herons" },
];
export const isDemoSeo = (seo) => typeof seo === "string" && seo.startsWith("demo-");
export const demoSchoolSeo = (name) => (DEMO_LEAGUE.find((t) => t.name.toLowerCase() === String(name || "").trim().toLowerCase()) || {}).seo || null;
