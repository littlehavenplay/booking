// GET /api/pass-balance?code=CODE
// Looks up a punch card so the booking page can show its type and visits left.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();
  if (!code) return json({ ok: false, error: "Enter a pass code." }, 400);

  const wantCard = url.searchParams.get("card") === "1";
  const store = getStore("passes");
  let rec = null;
  try { rec = await store.get("pass:" + code, { type: "json" }); } catch { rec = null; }
  if (!rec) return json({ ok: false, error: "That pass code wasn't found." }, 404);

  const expired = rec.expiry && rec.expiry < new Date().toISOString().slice(0, 10);

  // Card-display mode: return the e-punch-card data even at 0 visits / expired,
  // so the card page can render and prompt a refill.
  if (wantCard) {
    return json({
      ok: true, code: rec.code || code, admission: rec.admission, label: rec.label,
      visits: rec.visits || null, visitsRemaining: rec.visitsRemaining,
      expiry: rec.expiry, childName: rec.childName || "",
      active: rec.active !== false, expired: !!expired,
    });
  }

  if (expired)              return json({ ok: false, error: "That pass has expired." }, 409);
  // Active unless explicitly deactivated — legacy cards have no `active` field.
  // Must stay in step with book.js, checkin.js and passes-list.js.
  if (rec.active === false) return json({ ok: false, error: "That pass isn't active." }, 409);
  if ((rec.visitsRemaining || 0) < 1) return json({ ok: false, error: "That pass has no visits left." }, 409);

  return json({
    ok: true,
    admission: rec.admission,             // "regular" or "infant"
    label: rec.label,
    visitsRemaining: rec.visitsRemaining,
    visits: rec.visits || null,
    expiry: rec.expiry,
    childName: rec.childName || "",
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/pass-balance" };
