// POST /api/promo-admin  (admin key or staff PIN)
// Simple ongoing promo/flyer board — a Facebook/Instagram-style post: an image
// plus an optional short caption, nothing else. No dates, no requirements, no
// waiver links, no pricing — that's what the fuller "Upcoming events" tool is
// for. A promo just stays posted until staff remove it (a weekday discount
// flyer, an extended-summer-hours graphic, etc.)
//   action "list"   -> all promos (admin view)
//   action "save"   -> { id?, caption?, image? (data URL, required for a new post) }
//   action "delete" -> { id }
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("promos");
  const action = (b.action || "").toString();

  if (action === "list") {
    const keys = await listAllKeys(store, { prefix: "promo:" });
    const promos = [];
    for (const k of keys) {
      let p = null; try { p = await store.get(k, { type: "json" }); } catch {}
      if (p) promos.push({ id: p.id, caption: p.caption || "", hasImage: !!p.imageMime, createdAt: p.createdAt });
    }
    promos.sort((a, c) => (c.createdAt || "").localeCompare(a.createdAt || ""));
    return json({ ok: true, promos });
  }

  if (action === "save") {
    const id = (b.id || crypto.randomUUID()).toString();
    const caption = (b.caption || "").toString().slice(0, 500).trim();
    let existing = null;
    try { existing = await store.get("promo:" + id, { type: "json" }); } catch {}
    if (!existing && !(b.image && typeof b.image === "string" && b.image.startsWith("data:"))) {
      return json({ error: "A new post needs an image." }, 400);
    }
    const rec = {
      id, caption,
      imageMime: existing ? existing.imageMime || null : null,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
    };
    if (b.image && typeof b.image === "string" && b.image.startsWith("data:")) {
      const m = b.image.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { rec.imageMime = m[1]; try { await store.set("img:" + id, m[2]); } catch {} }
    }
    try { await store.setJSON("promo:" + id, rec); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, id, message: "Posted." });
  }

  if (action === "delete") {
    const id = (b.id || "").toString();
    try { await store.delete("promo:" + id); } catch {}
    try { await store.delete("img:" + id); } catch {}
    return json({ ok: true, message: "Removed." });
  }

  return json({ error: "Unknown action." }, 400);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/promo-admin" };
