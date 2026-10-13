// Small shared helpers for request bodies and API shapes.
export const clean = (v, max) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
export const year = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : null; };
export const player = (p) => ({ id: p.id, first: p.first_name, last: p.last_name, jersey: p.jersey, pos: p.pos, bats: p.bats, throws: p.throws, classYear: p.class_year, realPerson: !!p.real_person });
