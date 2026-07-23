// GET /api/news  — public. Returns the current homepage announcement, or {empty:true}.
import { getStore } from "@netlify/blobs";

export default async () => {
  let rec = null;
  try { rec = await getStore("site").get("news", { type: "json" }); } catch { rec = null; }
  if (!rec || !rec.body) return json({ empty: true });
  // Auto-expire: hide the day after showUntil (compared in Pacific time).
  if (rec.showUntil) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD
    if (today > rec.showUntil) return json({ empty: true });
  }
  return json({ headline: rec.headline || "", body: rec.body, showUntil: rec.showUntil || null, at: rec.at || null });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/news" };
