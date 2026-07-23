// POST /api/pass-buy
// Body: { items:[{passId, childName}], buyer:{name,phone,email}, sourceId, agree }
// Charges the buyer via Square (with tax), then issues one tracked punch card per
// item with a memorable code and visit balance, and emails the buyer their codes.

import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import {
  PASSES, passesFor, sellablePasses, passExpiryDate, TAX_RATE, STUDIO_NAME, PASS_POLICY_TITLE, PASS_POLICY_LINES,
  squareApiBase, SQUARE_VERSION,
} from "./lib-settings.js";

// Which sellable card a reload of an existing card maps to (by admission type).
// A legacy 5/10-visit card reloads into the current 8-visit card of the same type.
function reloadTargetId(admission) {
  return admission === "infant" ? "I8" : admission === "sibling" ? "S8" : "R8";
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const items = Array.isArray(body.items) ? body.items : [];
  const buyer = body.buyer || {};
  const name = (buyer.name || "").toString().slice(0, 120).trim();
  const email = (buyer.email || "").toString().slice(0, 160).trim();
  const phone = (buyer.phone || "").toString().slice(0, 40).trim();
  const sourceId = (body.sourceId || "").toString();

  if (!body.agree)       return json({ error: "Please accept the punch card policy." }, 400);
  if (!name)                              return json({ error: "Please enter your full name." }, 400);
  if (!/^\S+@\S+\.\S+$/.test(email))      return json({ error: "Please enter a valid email." }, 400);
  if ((phone.replace(/\D/g, "")).length < 7) return json({ error: "Please enter a valid phone number." }, 400);

  // ---- Reload mode: top up an EXISTING card, keep the same code ----
  // One-tap reload: the customer confirms payment for their existing code and the
  // new card's visits are ADDED on top of any visits still remaining (rollover).
  const reloadCode = (body.reloadCode || "").toString().trim().toUpperCase();
  if (reloadCode) {
    if (!sourceId) return json({ error: "Missing card details." }, 400);
    const env0 = process.env;
    if (!env0.SQUARE_ACCESS_TOKEN || !env0.SQUARE_LOCATION_ID) return json({ error: "Payments are not configured yet." }, 500);
    const store = getStore("passes");
    let rec = null;
    try { rec = await store.get("pass:" + reloadCode, { type: "json" }); } catch { rec = null; }
    if (!rec) return json({ error: "That punch card code wasn't found." }, 404);

    const targetId = reloadTargetId(rec.admission);
    const target = passesFor()[targetId];
    if (!target) return json({ error: "Unable to reload this card type." }, 400);
    const rSub = target.price, rTax = Math.round(rSub * TAX_RATE), rAmt = rSub + rTax;

    let pay;
    try {
      const res = await fetch(`${squareApiBase()}/v2/payments`, {
        method: "POST",
        headers: { "Square-Version": SQUARE_VERSION, "Authorization": `Bearer ${env0.SQUARE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(), source_id: sourceId,
          amount_money: { amount: rAmt, currency: "USD" }, location_id: env0.SQUARE_LOCATION_ID,
          autocomplete: true, note: `Punch card reload: ${reloadCode}`, buyer_email_address: email || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) return json({ error: "payment_failed", message: d?.errors?.[0]?.detail || "Payment was declined." }, 402);
      pay = d.payment;
    } catch { return json({ error: "payment_error", message: "Could not reach the payment processor." }, 502); }

    // Roll over: add the new visits on top of whatever's left; refresh expiry & type.
    const before = Math.max(0, rec.visitsRemaining || 0);
    const addVisits = target.visits;
    const now = new Date();
    const expiryDate = passExpiryDate(now, target.expiryMonths, rec.admission, rec.dobMonth, rec.dobYear);
    rec.visitsRemaining = before + addVisits;
    rec.visits = addVisits;                 // current card size going forward
    rec.passId = targetId;                  // now a current 8-visit card
    rec.label = target.label;
    rec.active = true;
    rec.expiry = expiryDate.toISOString().slice(0, 10);
    rec.lastReloadAt = now.toISOString();
    rec.reloadCount = (rec.reloadCount || 0) + 1;
    rec.reminderSentAt = null;              // reset so a future empty-card reminder can fire again
    try { await store.setJSON("pass:" + reloadCode, rec); } catch {}

    try {
      await sendPassEmail({ email: email || rec.buyerEmail, name: name || rec.buyerName,
        issued: [{ code: reloadCode, label: rec.label, visits: addVisits, childName: rec.childName || "", expiry: rec.expiry }],
        subtotal: rSub, tax: rTax, amount: rAmt, reloaded: true, visitsRemaining: rec.visitsRemaining });
    } catch {}

    return json({ ok: true, reloaded: true, code: reloadCode, addedVisits: addVisits,
      visitsRemaining: rec.visitsRemaining, amount: rAmt, subtotal: rSub, tax: rTax, expiry: rec.expiry });
  }

  if (!items.length)     return json({ error: "Please choose at least one punch card." }, 400);
  if (!sourceId)         return json({ error: "Missing card details." }, 400);

  // Validate items and compute totals server-side.
  const clean = [];
  const PASS_NOW = passesFor();   // punch card prices effective today (checkout date)
  for (const it of items) {
    const p = PASS_NOW[it.passId];
    if (!p || !p.sellable) return json({ error: "Unknown punch card option." }, 400);
    const childName = (it.childName || "").toString().slice(0, 80).trim();
    if (!childName) return json({ error: "Please enter the child's name for each punch card." }, 400);
    let dobMonth = null, dobYear = null;
    if (p.admission === "infant") {
      dobMonth = parseInt(it.dobMonth, 10);
      dobYear = parseInt(it.dobYear, 10);
      const yNow = new Date().getFullYear();
      if (!(dobMonth >= 1 && dobMonth <= 12) || !(dobYear >= yNow - 3 && dobYear <= yNow)) {
        return json({ error: "Please enter a valid birth month and year for the infant pass." }, 400);
      }
    }
    clean.push({ passId: it.passId, p, childName, dobMonth, dobYear });
  }
  const subtotal = clean.reduce((n, c) => n + c.p.price, 0);
  const tax = Math.round(subtotal * TAX_RATE);
  const amount = subtotal + tax;

  const env = process.env;
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) {
    return json({ error: "Payments are not configured yet." }, 500);
  }

  // Charge the buyer.
  let payment;
  try {
    const res = await fetch(`${squareApiBase()}/v2/payments`, {
      method: "POST",
      headers: { "Square-Version": SQUARE_VERSION, "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        source_id: sourceId,
        amount_money: { amount, currency: "USD" },
        location_id: env.SQUARE_LOCATION_ID,
        autocomplete: true,
        note: `Punch cards: ${clean.map(c => c.passId).join(", ")}`,
        buyer_email_address: email || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: "payment_failed", message: data?.errors?.[0]?.detail || "Payment was declined." }, 402);
    payment = data.payment;
  } catch (e) {
    return json({ error: "payment_error", message: "Could not reach the payment processor." }, 502);
  }

  // Issue the punch cards.
  const store = getStore("passes");
  const now = new Date();
  const issued = [];
  for (const c of clean) {
    const code = await uniqueCode(store, name, phone, c.p.typeNum);
    // Expiry: regular = 12 months from purchase. Infant = earlier of the child's
    // 18-month birthday or 12 months from purchase.
    const expiryDate = passExpiryDate(now, c.p.expiryMonths, c.p.admission, c.dobMonth, c.dobYear);
    const record = {
      code, passId: c.passId, label: c.p.label, admission: c.p.admission,
      visits: c.p.visits, visitsRemaining: c.p.visits,
      childName: c.childName, dobMonth: c.dobMonth, dobYear: c.dobYear,
      buyerName: name, buyerEmail: email, buyerPhone: phone,
      purchaseDate: now.toISOString(), expiry: expiryDate.toISOString().slice(0, 10),
      active: true, paymentId: payment?.id || null,
    };
    try { await store.setJSON("pass:" + code, record); } catch {}
    issued.push(record);
  }

  try { await sendPassEmail({ email, name, issued, subtotal, tax, amount }); } catch {}

  return json({
    ok: true,
    amount, subtotal, tax,
    passes: issued.map(r => ({ code: r.code, label: r.label, visits: r.visits, childName: r.childName, expiry: r.expiry })),
  });
};

// memorable code: initials + last4 phone + type number, with a uniqueness suffix if needed
async function uniqueCode(store, name, phone, typeNum) {
  const parts = name.trim().split(/\s+/);
  const fi = (parts[0]?.[0] || "X").toUpperCase();
  const li = (parts[parts.length - 1]?.[0] || "X").toUpperCase();
  const last4 = (phone.replace(/\D/g, "").slice(-4) || "0000").padStart(4, "0");
  const base = `${fi}${li}${last4}-${typeNum}`;
  for (let i = 0; i < 6; i++) {
    const code = i === 0 ? base : `${base}${randChar()}${randChar()}`;
    try { const exists = await store.get("pass:" + code, { type: "json" }); if (!exists) return code; }
    catch { return code; } // not found → available
  }
  return `${base}${Date.now().toString(36).slice(-3).toUpperCase()}`;
}
function randChar() { const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return c[Math.floor(Math.random() * c.length)]; }

function dollars(cents) { return "$" + (cents / 100).toFixed(2); }

async function sendPassEmail({ email, name, issued, subtotal, tax, amount, reloaded, visitsRemaining }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !email) return;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const heading = reloaded ? "Your punch card is reloaded 🌿" : "Your punch cards are ready 🌿";
  const intro = reloaded
    ? `Thank you${name ? ", " + name : ""}! We've added visits to your card — same code, ready to use. You now have <b>${visitsRemaining}</b> visit${visitsRemaining === 1 ? "" : "s"} remaining.`
    : `Thank you${name ? ", " + name : ""}! Use each code at checkout when you book an open play session — one visit is deducted per booking.`;

  const cards = issued.map(r => `
    <div style="background:#fcfaf6;border:1px solid #efe7da;border-radius:12px;padding:14px 16px;margin:10px 0">
      <div style="font-weight:bold;color:#2a2622">${r.label}${r.childName ? " — " + r.childName : ""}</div>
      <div style="font-size:22px;font-weight:bold;color:#a85f59;letter-spacing:1px;margin:6px 0">${r.code}</div>
      <div style="font-size:13px;color:#5c6470">${r.visits} visits · expires ${r.expiry}</div>
      <div style="font-size:13px;color:#5f7d52;margin-top:4px">☕ Free coffee for the grown-up, every visit</div>
      <div style="margin-top:10px"><a href="https://littlehavenplay.com/pass.html?code=${encodeURIComponent(r.code)}" style="display:inline-block;background:#7ba06c;color:#fff;text-decoration:none;font-weight:bold;font-size:13px;padding:9px 16px;border-radius:10px">View your digital card →</a></div>
    </div>`).join("");

  const policyHtml = PASS_POLICY_LINES.map(l => `<li style="margin:0 0 6px">${l}</li>`).join("");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:0 auto;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">${heading}</h2>
    <p style="margin:0 0 12px;color:#5c6470">${intro}</p>
    ${cards}
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:10px">
      <tr><td style="padding:4px 0;color:#5c6470">Subtotal</td><td style="padding:4px 0;text-align:right;font-weight:bold">${dollars(subtotal)}</td></tr>
      <tr><td style="padding:4px 0;color:#5c6470">Sales tax (8.75%)</td><td style="padding:4px 0;text-align:right;font-weight:bold">${dollars(tax)}</td></tr>
      <tr><td style="padding:6px 0 0;color:#5c6470">Total paid</td><td style="padding:6px 0 0;text-align:right;font-weight:bold;font-size:17px;color:#7ba676">${dollars(amount)}</td></tr>
    </table>
    <p style="margin:14px 0 0;font-size:13px;color:#5c6470;background:#fdf1ec;border-radius:10px;padding:12px 14px"><b>Expiration:</b> Regular punch cards expire <b>12 months from the purchase date</b>. Infant/Baby passes expire on the child's 18-month birthday or 12 months from purchase, whichever comes first. Each pass's expiration date is shown above.</p>
    <hr style="border:none;border-top:1px solid #efe7da;margin:18px 0">
    <h3 style="margin:0 0 8px;font-size:14px">${PASS_POLICY_TITLE}</h3>
    <ul style="margin:0;padding-left:18px;font-size:12px;color:#8a8276">${policyHtml}</ul>
    <p style="margin:14px 0 0;background:#fcfaf6;border:1px solid #efe7da;border-radius:10px;padding:11px 13px;font-size:13px;color:#5c6470"><b>📩 Don't see this email?</b> Please check your junk/spam folder and mark it "not spam" so you receive future confirmations.</p>
  </div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${STUDIO_NAME} <${from}>`, to: [email], bcc: bcc ? [bcc] : undefined,
      subject: `Your ${STUDIO_NAME} punch card${issued.length > 1 ? "s" : ""}`,
      html,
    }),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/pass-buy" };
