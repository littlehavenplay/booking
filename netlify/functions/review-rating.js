// /api/review-rating — the "★★★★★ 5.0 · Google · 10 reviews" badge shown on the homepage
// and the reviews page. Also handles the same badge for Yelp (pass platform=yelp).
//   GET  ?platform=google|yelp (default google)          → public: { ok, stars, count }
//   POST { key, action:"save", stars, count, platform? } → admin/staff: update it (default google)
import { getStore } from "@netlify/blobs";

const DEFAULT_RATING = { stars: 5, count: 10 };

function keyFor(platform) { return platform === "yelp" ? "review-rating:yelp" : "review-rating"; }

export default async (req) => {
  const store = getStore("site");
  const url = new URL(req.url);

  if (req.method === "GET") {
    const platform = (url.searchParams.get("platform") || "google").toLowerCase();
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

  const platform = (b.platform || "google").toLowerCase() === "yelp" ? "yelp" : "google";
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
