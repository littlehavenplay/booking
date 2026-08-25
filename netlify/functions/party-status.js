// POST /api/party-status   (staff PIN or admin key)
// Body: { pin, date, partySlot, action: "confirm" | "release" }

import { getStore } from "@netlify/blobs";
import { PARTY_SLOT_IDS, PARTY_SLOTS, slotKey } from "./lib-settings.js";
import { SIGNATURE_HTML } from "./lib-email.js";
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
    await sendDepositConfirmed(rec);
    return json({ ok: true, action: "confirmed",
      message: "Party confirmed." + (promoJustLocked ? ` ${rec.promo.label} locked in.` : "") + " Confirmation emailed to the customer." });
  }
  return json({ error: "Unknown action." }, 400);
};

function staffOk(pin) {
  return (!!process.env.STAFF_PIN && pin === process.env.STAFF_PIN) ||
         (!!process.env.ADMIN_KEY && pin === process.env.ADMIN_KEY);
}
// Deposit received -> tell the customer their party is secured.
async function sendDepositConfirmed(r) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const bcc = process.env.STUDIO_EMAIL || "";
  if (!key || !r || !r.email) return;
  // PARTY_SLOTS is an array of {id,label}, not a keyed object.
  const slotLabel = (PARTY_SLOTS.find(s => s.id === r.partySlot) || {}).label || r.partySlot || "";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `
  <div style="font-family:Nunito,Arial,sans-serif;max-width:560px;margin:0 auto;color:#2a2622">
    <h2 style="color:#a85f59;font-weight:normal">Your party is confirmed! 🎉</h2>
    <p style="color:#5c6470">We've received your deposit — <b>${esc(r.childName)}'s party</b> is officially on the calendar.</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <tr><td style="padding:5px 0;color:#5c6470;width:130px">Date</td><td style="padding:5px 0;font-weight:bold">${esc(r.date)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Time</td><td style="padding:5px 0;font-weight:bold">${esc(slotLabel)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Package</td><td style="padding:5px 0;font-weight:bold">${esc(r.packageLabel)}</td></tr>
    </table>
    ${r.promo ? `<div style="background:#e7f0df;border:1px solid #c2d7bd;border-radius:12px;padding:14px 16px;margin:14px 0">
      <p style="margin:0 0 6px;font-weight:bold;color:#3f5d33">🎉 ${esc(r.promo.name)} — ${esc(r.promo.label)}</p>
      <p style="margin:0;color:#5c6470;font-size:14px">Your <b>${esc(r.promo.label)}</b> is locked in and comes off your remaining
      balance when we settle up at the end of your party.</p>
    </div>` : ""}
    <p style="color:#5c6470">We'll be in touch soon to go over the details — theme, food choices and everything else.
    The remaining balance is due on the day of the party.</p>
    <p style="color:#5c6470;font-size:13px">Questions? Just reply to this email. — ${studio}</p>
  </div>`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${studio} <${from}>`, to: [r.email], bcc: bcc ? [bcc] : undefined,
        subject: `Party confirmed — ${r.childName}'s party on ${r.date}`, html: html + SIGNATURE_HTML }),
    });
  } catch {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/party-status" };
