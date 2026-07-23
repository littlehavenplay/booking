// POST /api/event-buy — public. Buy tickets for an upcoming event.
// Body: { eventId, quantity, name, email, sourceId }  (sourceId = Square card token)
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import { squareApiBase, SQUARE_VERSION, STUDIO_NAME } from "./lib-settings.js";

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
  if (new Date(e.dateTime).getTime() < Date.now()) return json({ error: "This event has already passed." }, 400);

  const sold = e.sold || 0;
  const remaining = Math.max(0, e.capacity - sold);
  if (e.regClose) {
    const nowPT = new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).slice(0, 16).replace(" ", "T");
    if (nowPT >= e.regClose) return json({ error: "closed", message: "Registration for this event has closed." }, 409);
  }
  if (remaining <= 0)                 return json({ error: "sold-out", message: "Sorry, this event is sold out." }, 409);
  if (quantity > remaining)           return json({ error: "limited", message: `Only ${remaining} ticket${remaining === 1 ? "" : "s"} left.` }, 409);

  // Sibling pricing: first ticket at e.price, each additional at e.siblingPrice (if set).
  let subtotal = (e.siblingPrice && quantity > 1)
    ? e.price + (quantity - 1) * e.siblingPrice
    : e.price * quantity;

  // Optional store credit (same credits the studio issues for open play).
  const creditCode = (b.creditCode || "").toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  let creditApplied = 0, creditRec = null;
  if (creditCode) {
    const creditStore = getStore("credits");
    try { creditRec = await creditStore.get("credit:" + creditCode, { type: "json" }); } catch { creditRec = null; }
    if (!creditRec)                    return json({ error: "credit", message: `Store credit ${creditCode} wasn't found.` }, 409);
    if (creditRec.expiry && creditRec.expiry < new Date().toISOString().slice(0, 10))
                                       return json({ error: "credit", message: `Store credit ${creditCode} has expired.` }, 409);
    if (!creditRec.active || creditRec.amount < 1)
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
        idempotency_key: crypto.randomUUID(),
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
  cur.buyers.push({ name, email, phone, attendees, quantity, paymentId, creditApplied: creditApplied || 0, creditCode: creditApplied ? creditCode : null, at: new Date().toISOString() });
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

  await sendConfirmation({ email, name, event: cur, quantity, amount });
  return json({ ok: true, message: "You're all set! A confirmation email is on its way." });
};

async function sendConfirmation({ email, name, event, quantity, amount }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || null;
  if (!key) return;
  const money = c => "$" + (c / 100).toFixed(2);
  const when = new Date(event.dateTime).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal">You're registered! 🎉</h2>
    <p>Hi ${esc(name)}, thank you for signing up for <b>${esc(event.title)}</b>.</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <tr><td style="padding:5px 0;color:#5c6470;width:130px">Event</td><td style="padding:5px 0;font-weight:bold">${esc(event.title)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">When</td><td style="padding:5px 0;font-weight:bold">${esc(when)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Tickets</td><td style="padding:5px 0;font-weight:bold">${quantity}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Total paid</td><td style="padding:5px 0;font-weight:bold">${money(amount)}</td></tr>
    </table>
    <p style="margin-top:14px;background:#fcfaf6;border:1px solid #efe7da;border-radius:10px;padding:11px 13px;font-size:14px"><b>📩 Don't see this email?</b> Please check your junk/spam folder and mark it "not spam" so you get future updates.</p>
    <p style="margin-top:12px;background:#fdf7f0;border:1px solid #ecdcc9;border-radius:10px;padding:11px 13px;font-size:14px"><b>🪪 Pickup:</b> The adult who drops off must be the same person who picks up, and must show a valid photo ID at pickup. No child will be released without a matching ID.</p>
    ${(event.waiverLink || event.regularWaiverLink) ? `
    <div style="margin-top:14px;background:#fdf7f0;border:1px solid #ecdcc9;border-radius:10px;padding:12px 14px">
      <b style="color:#a85f59">📋 Before the event — please complete the required waiver(s):</b>
      <p style="font-size:14px;margin:8px 0 0">Both must be signed unless you've already completed one previously.</p>
      <div style="margin-top:10px">
        ${event.waiverLink ? `<a href="${esc(event.waiverLink)}" style="display:inline-block;background:#a85f59;color:#fff;text-decoration:none;font-weight:bold;padding:9px 16px;border-radius:22px;margin:4px 8px 4px 0">Sign the event waiver →</a>` : ""}
        ${event.regularWaiverLink ? `<a href="${esc(event.regularWaiverLink)}" style="display:inline-block;background:#7ba676;color:#fff;text-decoration:none;font-weight:bold;padding:9px 16px;border-radius:22px;margin:4px 0">Sign the general waiver →</a>` : ""}
      </div>
    </div>` : ""}
    <p style="margin-top:14px">We can't wait to see you at ${STUDIO_NAME}!</p>
  </div>`;
  const text = `You're registered for ${event.title}!\n\nWhen: ${when}\nTickets: ${quantity}\nTotal paid: ${money(amount)}\n\nIf you don't see this email, please check your junk/spam folder.\n\nSee you at ${STUDIO_NAME}!`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${STUDIO_NAME} <${from}>`, to: [email], bcc: bcc ? [bcc] : undefined,
        subject: `You're registered — ${event.title}`, html: html + SIGNATURE_HTML, text }),
    });
  } catch {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/event-buy" };
