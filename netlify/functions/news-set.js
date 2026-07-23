// POST /api/news-set  (admin or staff). Body: { key, headline, body, action: "save"|"clear" }
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("site");

  if ((b.action || "save") === "clear") {
    try { await store.delete("news"); } catch {}
    return json({ ok: true, cleared: true, message: "News cleared — the banner is now hidden on the site." });
  }

  const headline = (b.headline || "").toString().slice(0, 120).trim();
  const body = (b.body || "").toString().slice(0, 1000).trim();
  const showUntil = (b.showUntil || "").toString().trim();   // YYYY-MM-DD, optional
  if (!body) return json({ error: "Enter a news message." }, 400);

  try { await store.setJSON("news", { headline, body, showUntil: /^\d{4}-\d{2}-\d{2}$/.test(showUntil) ? showUntil : null, at: new Date().toISOString() }); }
  catch { return json({ error: "Couldn't save. Try again." }, 502); }
  return json({ ok: true, message: "News posted — it's now showing on your homepage." });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/news-set" };
