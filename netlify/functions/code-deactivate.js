// POST /api/code-deactivate   (protected by ADMIN_KEY)
// Body: { key, code }
// Deactivates a punch card or a store-credit code so it can no longer be used
// (e.g. after a refund or accidental charge). Gift cards are managed in the
// Square Dashboard.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  if (!adminKey)                     return json({ error: "Admin key isn't configured. Set ADMIN_KEY in Netlify." }, 500);
  if ((body.key || "") !== adminKey) return json({ error: "Wrong admin key." }, 401);

  const code = (body.code || "").toString().trim().toUpperCase();
  if (!code) return json({ error: "Enter a code to deactivate." }, 400);

  // Punch card?
  const passes = getStore("passes");
  let pass = null;
  try { pass = await passes.get("pass:" + code, { type: "json" }); } catch { pass = null; }
  if (pass) {
    pass.active = false;
    pass.visitsRemaining = 0;
    try { await passes.setJSON("pass:" + code, pass); } catch {}
    return json({ ok: true, type: "Punch card", code, message: "Punch card deactivated. It can no longer be redeemed." });
  }

  // Store credit?
  const credits = getStore("credits");
  let credit = null;
  try { credit = await credits.get("credit:" + code, { type: "json" }); } catch { credit = null; }
  if (credit) {
    credit.active = false;
    credit.amount = 0;
    try { await credits.setJSON("credit:" + code, credit); } catch {}
    return json({ ok: true, type: "Store credit", code, message: "Store credit deactivated. It can no longer be used." });
  }

  return json({
    ok: false,
    error: "That code wasn't found among punch cards or store credit. If it's a gift card, deactivate it in your Square Dashboard → Gift Cards.",
  }, 404);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/code-deactivate" };
