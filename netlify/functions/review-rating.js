// /api/review-rating — the "★★★★★ 5.0 · Google · 10 reviews" badge shown on the
// homepage and Reviews page. Handles Google, Yelp, and Facebook the same way —
// just pass a different platform.
//   GET  ?platform=google|yelp|facebook (default google)  → public: { ok, stars, count }
//   POST { key, action:"save", stars, count, platform? }  → admin/staff: update it (default google)
import { getStore } from "@netlify/blobs";

const DEFAULT_RATING = { stars: 5, count: 10 };
const PLATFORMS = ["google", "yelp", "facebook"];

function keyFor(platform) { return platform === "google" ? "review-rating" : "review-rating:" + platform; }
function normalizePlatform(p) { p = (p || "google").toLowerCase(); return PLATFORMS.includes(p) ? p : "google"; }

export default async (req) => {
  const store = getStore("site");
  const url = new URL(req.url);

  if (req.method === "GET") {
    const platform = normalizePlatform(url.searchParams.get("platform"));
    let rec = null;
    try { rec = await store.get(keyFor(platform), { type: "json" }); } catch {}
    const stars = rec && Number.isFinite(rec.stars) ? rec.stars : DEFAULT_RATING.stars;
    const count = rec && Number.isFinite(rec.count) ? rec.count : DEFAULT_RATING.count;
    return json({ ok: true, stars, count, platform });
  }

  if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const platform = normalizePlatform(b.platform);
  let stars = Number(b.stars);
  let count = Number(b.count);
  if (!Number.isFinite(stars) || stars < 0 || stars > 5) return json({ error: "Star rating must be a number between 0 and 5." }, 400);
  if (!Number.isFinite(count) || count < 0 || count > 100000) return json({ error: "Review count must be a whole number." }, 400);
  stars = Math.round(stars * 10) / 10;
  count = Math.round(count);

  try { await store.setJSON(keyFor(platform), { stars, count, at: new Date().toISOString() }); }
  catch { return json({ error: "Couldn't save. Try again." }, 502); }
  return json({ ok: true, stars, count, platform });
};

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/review-rating" };
