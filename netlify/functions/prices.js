// POST /api/prices   (admin key or staff PIN)
// Lets staff manually set the current Regular/Sibling/Infant admission prices —
// no code changes, no redeploy. Saved prices take effect immediately for every
// new booking, everywhere: the homepage display, the booking page display, the
// live running total on the booking page, AND the actual amount charged at
// checkout — all of these read from the exact same pricesFor() function in
// lib-settings.js, so there's only one source of truth and nothing can drift
// out of sync with what's actually being charged.
//   { key, action:"get" }                                    -> current prices (public-safe read, but still requires a key for consistency with the rest of this tool)
//   { key, action:"save", regular, sibling, infant }          -> dollars, not cents
import { getStore } from "@netlify/blobs";
import { pricesFor } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("site");
  const action = (b.action || "get").toString();

  if (action === "get") {
    const prices = await pricesFor();
    return json({ ok: true, prices });
  }

  if (action === "save") {
    const toCents = (v, label) => {
      const n = parseFloat(v);
      if (!Number.isFinite(n) || n < 0 || n > 500) throw new Error(`${label} must be a dollar amount between $0 and $500.`);
      return Math.round(n * 100);
    };
    let regular, sibling, infant;
    try {
      regular = toCents(b.regular, "Regular admission");
      sibling = toCents(b.sibling, "Sibling add-on");
      infant = toCents(b.infant, "Baby/Infant admission");
    } catch (e) {
      return json({ error: e.message }, 400);
    }
    const rec = { regular, sibling, infant, updatedAt: new Date().toISOString() };
    try { await store.setJSON("prices", rec); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, prices: { regular, sibling, infant } });
  }

  return json({ error: "Unknown action." }, 400);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/prices" };
