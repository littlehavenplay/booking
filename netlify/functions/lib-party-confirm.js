// The ONE "your party is confirmed" email, sent at most once per party.
//
// A party can be confirmed from more than one place (marking the deposit paid in
// the parties list, the Confirm button). Each used to send its own email, with its
// own wording, every time it was pressed, so customers got two or three copies.
// Now every path calls sendPartyConfirmedOnce():
//   - it re-reads the party and skips if it was already emailed (confirmEmailedAt)
//   - it sends with a fixed idempotency key per party, so even two taps landing at
//     the same instant produce one email
//   - it records confirmEmailedAt on the party
import { getStore } from "@netlify/blobs";
import { PARTY_SLOTS, WAIVER_URL } from "./lib-settings.js";
import { SIGNATURE_HTML, fromHeader, resendEmail } from "./lib-email.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function partyConfirmedHtml(r) {
  const slotLabel = r.slotLabel || (PARTY_SLOTS.find(s => s.id === r.partySlot) || {}).label || r.partySlot || "";
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#2a2622;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 6px">Your party is confirmed! 🎉</h2>
    <p style="color:#5c6470;margin:0 0 12px">Hi ${esc(r.name) || "there"} — we've received your deposit and ${r.childName ? `<b>${esc(r.childName)}'s party</b>` : "your party"} is on the calendar.</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <tr><td style="padding:5px 0;color:#5c6470;width:110px">Date</td><td style="padding:5px 0;font-weight:bold">${esc(r.date)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Time</td><td style="padding:5px 0;font-weight:bold">${esc(slotLabel)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Package</td><td style="padding:5px 0;font-weight:bold">${esc(r.packageLabel || r.package)}</td></tr>
    </table>
    ${r.promo ? `<div style="background:#e7f0df;border:1px solid #c2d7bd;border-radius:12px;padding:12px 16px;margin:14px 0">
      <p style="margin:0;color:#3f5d33"><b>🎉 ${esc(r.promo.label)}</b> comes off your balance on the day.</p>
    </div>` : ""}
    <div style="background:#f3f0ff;border-radius:12px;padding:14px 16px;margin:14px 0">
      <p style="margin:0 0 10px;color:#5c6470;font-size:14px">📋 Please forward the waiver to your guests so everyone signs before arriving:</p>
      <a href="${WAIVER_URL}" style="display:inline-block;background:#7a6253;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:10px">Sign the waiver →</a>
    </div>
    <p style="color:#5c6470;margin:0 0 6px">The remaining balance is due on the day of the party.</p>
    <p style="color:#5c6470;font-size:13px;margin:0">Questions? Just reply to this email. — ${esc(studio)}</p>
  </div>`;
}

// r = the party record; key = its key in the "parties" store.
// Returns "sent" | "already-sent" | "no-email" | "failed".
export async function sendPartyConfirmedOnce(key, r) {
  if (!r || !r.email) return "no-email";
  const store = getStore({ name: "parties", consistency: "strong" });
  let fresh = null;
  try { fresh = await store.get(key, { type: "json" }); } catch {}
  const rec = fresh || r;
  if (rec.confirmEmailedAt) return "already-sent";

  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const ok = await resendEmail({
    from: fromHeader(from, studio),
    to: [rec.email],
    subject: `Your party is confirmed — ${rec.childName ? rec.childName + "'s party on " : ""}${rec.date}`,
    html: partyConfirmedHtml(rec) + SIGNATURE_HTML,
  }, { idempotencyKey: "party-confirmed:" + key + ":" + (rec.at || rec.date) });
  if (!ok) return "failed";

  rec.confirmEmailedAt = new Date().toISOString();
  try { await store.setJSON(key, rec); } catch {}
  return "sent";
}
