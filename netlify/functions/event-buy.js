// POST /api/event-buy — public. Buy tickets for an upcoming event.
// Body: { eventId, quantity, name, email, sourceId }  (sourceId = Square card token)
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { SIGNATURE_HTML, resendEmail, footerText, TERMS } from "./lib-email.js";
import { squareApiBase, SQUARE_VERSION, STUDIO_NAME } from "./lib-settings.js";
import { eventPacificParts, eventIsPast } from "./lib-closures.js";
import { findMemberFor } from "./lib-playclub.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const eventId = (b.eventId || "").toString();
  const quantity = Math.max(1, Math.min(20, parseInt(b.quantity, 10) || 0));
  const name = (b.name || "").toString().slice(0, 120).trim();
  const email = (b.email || "").toString().slice(0, 160).trim();
  const phone = (b.phone || "").toString().slice(0, 40).trim();
  // Attendees: [{ name, age }] — one per child.
  const attendees = Array.isArray(b.attendees)
    ? b.attendees.map(a => ({ name: (a && a.name || "").toString().slice(0, 80).trim(),
                              age: (a && a.age || "").toString().slice(0, 12).trim() }))
                 .filter(a => a.name)
    : [];
  const sourceId = (b.sourceId || "").toString();

  if (!name)                          return json({ error: "Please enter your name." }, 400);
  if (!/^\S+@\S+\.\S+$/.test(email))  return json({ error: "Please enter a valid email." }, 400);
  if (quantity < 1)                   return json({ error: "Choose how many tickets." }, 400);

  const store = getStore("events");
  let e = null;
  try { e = await store.get("event:" + eventId, { type: "json" }); } catch { e = null; }
  if (!e || e.hidden)                 return json({ error: "That event isn't available." }, 404);
  if (eventIsPast(e.dateTime)) return json({ error: "This event has already passed." }, 400);

  const sold = e.sold || 0;
  const remaining = Math.max(0, e.capacity - sold);
  if (e.regClose) {
    const nowPT = new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).slice(0, 16).replace(" ", "T");
    if (nowPT >= e.regClose) return json({ error: "closed", message: "Registration for this event has closed." }, 409);
  }
  if (remaining <= 0)                 return json({ error: "sold-out", message: "Sorry, this event is sold out." }, 409);
  if (quantity > remaining)           return json({ error: "limited", message: `Only ${remaining} ticket${remaining === 1 ? "" : "s"} left.` }, 409);

  // ---- Play Club member price ------------------------------------------
  // Checked HERE, on the server, from the membership store -- never trusted
  // from the browser. The page shows the discount for a nice experience, but
  // this is what decides the charge, so a forged request just pays full price.
  // findMemberFor() already refuses paused, ended and inactive memberships,
  // and deliberately gets no date: ANY active membership earns the event rate,
  // including a weekday plan on a weekend event.
  let member = null;
  if (e.memberPrice > 0 && e.memberPrice < e.price) {
    try {
      member = await findMemberFor({
        code: (b.playClubCode || "").toString(),
        phone: (b.playClubPhone || b.phone || "").toString(),
      });
    } catch { member = null; }
  }
  const firstTicket = member ? e.memberPrice : e.price;
  const memberSaving = member ? (e.price - e.memberPrice) : 0;

  // Sibling pricing: first ticket at the member/standard rate, each additional
  // at e.siblingPrice (if set). Sibling tickets never take the member discount
  // on top -- they are already a discounted rate.
  let subtotal = (e.siblingPrice && quantity > 1)
    ? firstTicket + (quantity - 1) * e.siblingPrice
    : firstTicket + (quantity - 1) * e.price;

  // Optional store credit (same credits the studio issues for open play).
  const creditCode = (b.creditCode || "").toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  let creditApplied = 0, creditRec = null;
  if (creditCode) {
    const creditStore = getStore("credits");
    try { creditRec = await creditStore.get("credit:" + creditCode, { type: "json" }); } catch { creditRec = null; }
    if (!creditRec)                    return json({ error: "credit", message: `Store credit ${creditCode} wasn't found.` }, 409);
    if (creditRec.expiry && creditRec.expiry < new Date().toISOString().slice(0, 10))
                                       return json({ error: "credit", message: `Store credit ${creditCode} has expired.` }, 409);
    // Same contract as book.js.
    if (creditRec.active === false || (creditRec.amount || 0) < 1)
                                       return json({ error: "credit", message: `Store credit ${creditCode} has no balance left.` }, 409);
    creditApplied = Math.min(subtotal, creditRec.amount);
  }
  const amount = Math.max(0, subtotal - creditApplied);
  if (amount > 0 && !sourceId)        return json({ error: "Card details are required." }, 400);

  // Charge Square
  let paymentId = null;
  if (amount > 0) {
    const res = await fetch(`${squareApiBase()}/v2/payments`, {
      method: "POST",
      headers: { "Square-Version": SQUARE_VERSION, "Authorization": `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // Stable per logical purchase so a retry or double-tap returns the
        // original payment instead of charging the buyer a second time.
        idempotency_key: createHash("sha256")
          .update([(b.attemptId || "").toString().slice(0, 60), eventId, email, quantity, amount].join("|"))
          .digest("hex").slice(0, 45),
        source_id: sourceId,
        amount_money: { amount, currency: "USD" },
        location_id: process.env.SQUARE_LOCATION_ID,
        autocomplete: true,
        note: `${e.title} — ${quantity} ticket(s)`,
        buyer_email_address: email || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data?.errors?.[0]?.detail || "Payment was declined." }, 402);
    paymentId = data.payment?.id || null;
  }

  // Record the sale (last-write-wins; re-read to reduce races)
  let cur = e;
  try { cur = await store.get("event:" + eventId, { type: "json" }) || e; } catch {}
  cur.sold = (cur.sold || 0) + quantity;
  cur.buyers = Array.isArray(cur.buyers) ? cur.buyers : [];
  cur.buyers.push({ name, email, phone, attendees, quantity, paymentId, playClubCode: member ? member.code : null, memberSaving, creditApplied: creditApplied || 0, creditCode: creditApplied ? creditCode : null, at: new Date().toISOString() });
  try { await store.setJSON("event:" + eventId, cur); } catch {}

  // Burn the store credit (payment succeeded).
  if (creditApplied > 0 && creditRec) {
    const creditStore = getStore("credits");
    let fresh = creditRec;
    try { fresh = await creditStore.get("credit:" + creditCode, { type: "json" }) || creditRec; } catch {}
    if (fresh.singleUse || fresh.type === "courtesy") { fresh.active = false; fresh.amount = 0; }
    else { fresh.amount = Math.max(0, (fresh.amount || 0) - creditApplied); if (fresh.amount < 1) fresh.active = false; }
    fresh.usedAt = new Date().toISOString();
    try { await creditStore.setJSON("credit:" + creditCode, fresh); } catch {}
  }

  await sendConfirmation({ email, name, event: cur, quantity, amount, member, memberSaving, subtotal, creditApplied });
  return json({ ok: true, message: "You're all set! A confirmation email is on its way." });
};

async function sendConfirmation({ email, name, event, quantity, amount, member = null, memberSaving = 0, subtotal = 0, creditApplied = 0 }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || null;
  if (!key) return;
  const money = c => "$" + (c / 100).toFixed(2);
  const _ep = eventPacificParts(event.dateTime); const when = _ep ? `${_ep.dateLabel} at ${_ep.timeLabel}` : "";
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Same pastel gold band as the open-play confirmation, so a member sees their
  // membership working here too.
  const memberBanner = member ? `
    <div style="background:linear-gradient(135deg,#f7ecd2 0%,#f2e2c0 55%,#efdcb4 100%);border:1px solid #e6d3a8;border-radius:14px;padding:11px 16px;margin:0 0 14px;text-align:center">
      <div style="font-size:12px;letter-spacing:.2em;font-weight:bold;color:#8a6b2f">\u2726 PLAY CLUB MEMBER \u2726</div>
    </div>` : "";
  const memberRow = (member && memberSaving > 0) ? `
      <tr><td style="padding:5px 0;color:#8a6b2f">\u{1F39F}\uFE0F Play Club member price</td><td style="padding:5px 0;text-align:right;font-weight:bold;color:#8a6b2f">\u2212${money(memberSaving)}</td></tr>` : "";
  const creditRow = creditApplied > 0 ? `
      <tr><td style="padding:5px 0;color:#5c6470">Store credit</td><td style="padding:5px 0;text-align:right;font-weight:bold">\u2212${money(creditApplied)}</td></tr>` : "";

  // Two buttons, no explanation. The event form differs per event; the waiver
  // link is the standing WaiverMaster one. Both are required before the event.
  const btn = (href, label, bg) =>
    `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:.04em;text-transform:uppercase;padding:12px 22px;border-radius:40px;margin:5px 4px">${label}</a>`;
  const forms = (event.waiverLink || event.regularWaiverLink) ? `
    <div style="margin:18px 0;text-align:center">
      <p style="margin:0 0 8px;font-size:13px;color:#5c6470"><b>Both are required before the event.</b></p>
      ${event.waiverLink ? btn(event.waiverLink, "Special event form", "#a85f59") : ""}
      ${event.regularWaiverLink ? btn(event.regularWaiverLink, "Sign your waiver", "#7ba676") : ""}
    </div>` : "";

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;line-height:1.6">
    ${memberBanner}
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">You're registered! \u{1F389}</h2>
    <p style="margin:0 0 14px;color:#5c6470">Thank you, ${esc(name)} — here are your details.</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <tr><td style="padding:5px 0;color:#5c6470;width:120px">Event</td><td style="padding:5px 0;text-align:right;font-weight:bold">${esc(event.title)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">When</td><td style="padding:5px 0;text-align:right;font-weight:bold">${esc(when)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Tickets</td><td style="padding:5px 0;text-align:right;font-weight:bold">${quantity}</td></tr>
      ${(memberRow || creditRow) ? `<tr><td style="padding:5px 0;color:#5c6470">Subtotal</td><td style="padding:5px 0;text-align:right">${money(subtotal)}</td></tr>` : ""}
      ${memberRow}
      ${creditRow}
      <tr><td style="padding:6px 0 0;color:#5c6470">Total paid</td><td style="padding:6px 0 0;text-align:right;font-weight:bold;font-size:18px;color:#7ba676">${money(amount)}</td></tr>
    </table>
    ${forms}
    <p style="margin:4px 0 0;font-size:12px;color:#aea298;text-align:center">\u{1FAAA} The adult dropping off must show photo ID at pickup.</p>
  </div>`;

  const text = `You're registered for ${event.title}!\n\nWhen: ${when}\nTickets: ${quantity}\n`
    + (member && memberSaving > 0 ? `Play Club member price: \u2212${money(memberSaving)}\n` : "")
    + `Total paid: ${money(amount)}\n\n`
    + (event.waiverLink ? `Special event form: ${event.waiverLink}\n` : "")
    + (event.regularWaiverLink ? `Sign your waiver: ${event.regularWaiverLink}\n` : "")
    + `Both are required before the event.\n`
    + footerText(TERMS.all);

  try {
    await resendEmail({ from: `${STUDIO_NAME} <${from}>`, to: [email], bcc: bcc ? [bcc] : undefined,
      subject: `You're registered — ${event.title}`, html: html + SIGNATURE_HTML, text });
  } catch {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/event-buy" };
