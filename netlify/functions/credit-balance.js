// GET /api/credit-balance?code=CODE
// Returns the remaining store-credit balance so the booking page can show it.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();
  if (!code) return json({ ok: false, error: "Enter a promo code." }, 400);

  const store = getStore("credits");
  let rec = null;
  try { rec = await store.get("credit:" + code, { type: "json" }); } catch { rec = null; }
  if (!rec)        return json({ ok: false, error: "That promo code wasn't found." }, 404);

  const expired = rec.expiry && rec.expiry < new Date().toISOString().slice(0, 10);
  if (expired)             return json({ ok: false, error: "That promo code has expired." }, 409);
  if (!rec.active || rec.amount < 1) return json({ ok: false, error: "That promo code has no balance left." }, 409);

  return json({ ok: true, balance: rec.amount, expiry: rec.expiry });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/credit-balance" };
