// POST /api/passes-list  (admin key or staff PIN) — all punch cards, newest purchase first.
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "", provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("passes");
  const keys = await listAllKeys(store, { prefix: "pass:" });
  const today = new Date().toISOString().slice(0, 10);
  const passes = [];
  for (const k of keys) {
    try {
      const r = await store.get(k, { type: "json" });
      if (!r || !r.code) continue;
      const expired = r.expiry && r.expiry < today;
      const usedUp = (r.visitsRemaining || 0) < 1;
      const status = (r.active === false) ? "inactive" : expired ? "expired" : usedUp ? "usedup" : "active";
      // Legacy = an old 5- or 10-visit card (new cards are always 8 visits).
      const legacy = (r.visits === 5 || r.visits === 10);
      passes.push({
        code: r.code, label: r.label || "", admission: r.admission || "",
        visits: r.visits || null, visitsRemaining: r.visitsRemaining || 0,
        childName: r.childName || "", name: r.buyerName || "", email: r.buyerEmail || "", phone: r.buyerPhone || "",
        purchaseDate: r.purchaseDate || "", expiry: r.expiry || "", status,
        legacy, reloadCount: r.reloadCount || 0,
      });
    } catch {}
  }
  passes.sort((a, c) => (c.purchaseDate || "").localeCompare(a.purchaseDate || ""));
  return json({ ok: true, passes, count: passes.length });
};
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
export const config = { path: "/api/passes-list" };
