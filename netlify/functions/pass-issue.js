// POST /api/pass-issue  (admin key or staff PIN)
// Legacy prepaid punch cards are DISCONTINUED for new sales — no new ones can be
// minted. Existing holders get one grandfathered perk for having been with the
// studio from the start: they can reload 10 more visits, paid in person (Square,
// outside this system entirely), at 20% off THAT DAY'S current admission price
// for their card's type — every time they reload, not just once. Reloaded
// visits never expire. This endpoint also still does the original "fix an
// existing card's exact visit count" correction tool.
//   { key, fixCode, setVisits }                    → correct an existing card (unchanged)
//   { key, action:"reload-preview", code }          → shows the exact price to charge, no changes made
//   { key, action:"reload-confirm", code }          → staff confirms payment was collected in Square; adds 10 visits, clears expiry, logs the date
import { getStore } from "@netlify/blobs";
import { PASSES, passExpiryDate, pricesFor } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const action = (b.action || "").toString();
  const store = getStore("passes");

  if (action === "reload-preview" || action === "reload-confirm") {
    const code = (b.code || "").toString().trim().toUpperCase();
    if (!code) return json({ error: "Enter the punch card code." }, 400);
    let rec = null; try { rec = await store.get("pass:" + code, { type: "json" }); } catch {}
    if (!rec) return json({ error: "That punch card code wasn't found." }, 404);
    const admission = rec.admission === "infant" ? "infant" : rec.admission === "sibling" ? "sibling" : "regular";
    const prices = await pricesFor();
    const perVisit = prices[admission] || 0;
    const RELOAD_VISITS = 10, RELOAD_DISCOUNT = 0.20;
    const fullPrice = perVisit * RELOAD_VISITS;
    const reloadPrice = Math.round(fullPrice * (1 - RELOAD_DISCOUNT));
    const visitsBefore = rec.visitsRemaining || 0;

    if (action === "reload-preview") {
      return json({ ok: true, code, admission, childName: rec.childName || "", buyerName: rec.buyerName || "",
        visitsBefore, visitsAfter: visitsBefore + RELOAD_VISITS,
        perVisitCents: perVisit, reloadPriceCents: reloadPrice, reloadVisits: RELOAD_VISITS,
        reloadCount: rec.reloadCount || 0 });
    }

    // reload-confirm — staff has already collected reloadPriceCents in Square in store.
    rec.visitsRemaining = visitsBefore + RELOAD_VISITS;
    rec.active = true;
    rec.expiry = null;   // grandfathered reloads never expire, per studio policy
    rec.reloadCount = (rec.reloadCount || 0) + 1;
    rec.lastReloadedAt = new Date().toISOString();
    rec.history = Array.isArray(rec.history) ? rec.history : [];
    rec.history.push({ at: rec.lastReloadedAt, action: "reloaded", visitsAdded: RELOAD_VISITS,
      pricePaid: reloadPrice, visitsAfter: rec.visitsRemaining });
    try { await store.setJSON("pass:" + code, rec); }
    catch { return json({ error: "Couldn't save the reload. Try again." }, 502); }

    return json({ ok: true, code, visitsRemaining: rec.visitsRemaining, reloadCount: rec.reloadCount,
      reloadedAt: rec.lastReloadedAt, pricePaid: reloadPrice });
  }

  // ---- Fix / correct an EXISTING card — the original tool, unchanged. ----
  // Sets the EXACT visits remaining (not additive) and refreshes the expiry to a
  // valid future date. Use this to undo a mistaken redemption or repair a bad expiry.
  const fixCode = (b.fixCode || "").toString().trim().toUpperCase();
  if (!fixCode) return json({ error: "Enter a code to fix, or use the Reload tool to grandfather-reload a legacy card." }, 400);

  const storeF = getStore("passes");
  let rec = null;
  try { rec = await storeF.get("pass:" + fixCode, { type: "json" }); } catch { rec = null; }
  if (!rec) return json({ error: "That punch card code wasn't found." }, 404);
  const setVisits = parseInt(b.setVisits, 10);
  if (!Number.isFinite(setVisits) || setVisits < 0) return json({ error: "Enter the exact number of visits to set (0 or more)." }, 400);
  const nowF = new Date();
  const tId = rec.admission === "infant" ? "I8" : rec.admission === "sibling" ? "S8" : "R8";
  const tF = PASSES[tId] || {};
  const expF = passExpiryDate(nowF, tF.expiryMonths, rec.admission, rec.dobMonth, rec.dobYear);
  rec.visitsRemaining = setVisits;
  rec.active = true;
  rec.expiry = expF.toISOString().slice(0, 10);
  rec.reminderSentAt = null;
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  rec.history.push({ at: nowF.toISOString(), action: "corrected", setVisits, expiry: rec.expiry });
  try { await storeF.setJSON("pass:" + fixCode, rec); }
  catch { return json({ error: "Couldn't update the card. Try again." }, 502); }
  return json({ ok: true, fixed: true, code: fixCode, label: rec.label || "",
    visitsRemaining: rec.visitsRemaining, expiry: rec.expiry });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/pass-issue" };
