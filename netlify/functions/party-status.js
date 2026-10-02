// POST /api/party-status   (staff PIN or admin key)
// Body: { pin, date, partySlot, action: "confirm" | "release" }

import { getStore } from "@netlify/blobs";
import { PARTY_SLOT_IDS, PARTY_SLOTS, slotKey } from "./lib-settings.js";
import { sendPartyConfirmedOnce } from "./lib-party-confirm.js";
import { logPromoClaim } from "./partypromo.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const pin = (b.pin || "").toString();
  if (!staffOk(pin)) return json({ error: "Wrong staff PIN." }, 401);

  const date = (b.date || "").trim();
  const partySlot = (b.partySlot || "").trim();
  const action = (b.action || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a valid date." }, 400);
  if (!PARTY_SLOT_IDS.includes(partySlot)) return json({ error: "Pick a valid party time." }, 400);

  const parties = getStore("parties");
  const key = slotKey(date, partySlot);

  if (action === "release") {
    try { await parties.delete(key); } catch {}
    return json({ ok: true, action: "released", message: "Party released. The slot is open again (and overlapping open play reopens)." });
  }
  if (action === "confirm") {
    let rec = null;
    try { rec = await parties.get(key, { type: "json" }); } catch { rec = null; }
    if (!rec) return json({ error: "No party found in that slot." }, 404);
    rec.status = "confirmed";
    rec.confirmedAt = new Date().toISOString();
    // The deposit is what earns the promo. Lock it in here, once, and record the
    // claim so there's a list of who took the offer.
    let promoJustLocked = false;
    if (rec.promo && rec.promo.pending) {
      rec.promo.pending = false;
      rec.promo.lockedAt = rec.confirmedAt;
      promoJustLocked = true;
    }
    try { await parties.setJSON(key, rec); } catch { return json({ error: "Couldn't update. Try again." }, 502); }
    if (promoJustLocked) {
      await logPromoClaim({
        name: rec.promo.name, label: rec.promo.label, amount: rec.promo.amount,
        partyDate: rec.date, partySlot: rec.partySlot, packageLabel: rec.packageLabel,
        bookedOn: rec.promo.bookedOn, customer: rec.name, email: rec.email, childName: rec.childName,
      });
    }
    // Nothing used to reach the customer when the deposit was marked paid — they
    // were left wondering whether it had gone through. Send the confirmation.
    // One confirmation per party, ever — shared with "mark deposit paid".
    let emailed = "";
    try { emailed = await sendPartyConfirmedOnce(key, rec); } catch {}
    return json({ ok: true, action: "confirmed", emailed,
      message: "Party confirmed." + (promoJustLocked ? ` ${rec.promo.label} locked in.` : "")
        + (emailed === "sent" ? " Confirmation emailed to the customer."
          : emailed === "already-sent" ? " (Confirmation was already emailed earlier — not sent again.)" : "") });
  }
  return json({ error: "Unknown action." }, 400);
};

function staffOk(pin) {
  return (!!process.env.STAFF_PIN && pin === process.env.STAFF_PIN) ||
         (!!process.env.ADMIN_KEY && pin === process.env.ADMIN_KEY);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/party-status" };
