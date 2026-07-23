// POST /api/credit-issue   (admin key or staff PIN)
// Body: { key, amount, reason, email?, type }   type = "courtesy" | "standard"
//   courtesy = single-use, online + open-play only, 3-month expiry, flyer email
//   standard = balance (carries over), redeemable anywhere (online + in store), 3-month expiry
import { getStore } from "@netlify/blobs";

import { SIGNATURE_HTML } from "./lib-email.js";
const SITE = "https://littlehavenplay.com";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (body.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured. Set ADMIN_KEY in Netlify." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const type = (body.type || "standard").toString() === "courtesy" ? "courtesy" : "standard";
  const dollars = parseFloat(body.amount);
  if (!(dollars > 0))         return json({ error: "Enter a dollar amount greater than 0." }, 400);
  const amount = Math.round(dollars * 100); // cents
  const reason = (body.reason || "").toString().slice(0, 200).trim();

  // Expiry is selectable at issuance (default 30 days). The admin/staff dropdown
  // sends expiryDays: 30 / 60 / 90 / 180 (6 months) / 365 (1 year).
  let expiryDays = parseInt(body.expiryDays, 10);
  if (!Number.isFinite(expiryDays) || expiryDays < 1) {
    expiryDays = parseInt(process.env.CREDIT_EXPIRY_DAYS || "30", 10);
  }
  expiryDays = Math.min(Math.max(expiryDays, 1), 366);
  const expiryLabel = expiryDays >= 365 ? "1 year" : expiryDays >= 180 ? "6 months" : (expiryDays + " days");
  const now = new Date();
  const exp = new Date(now.getTime() + expiryDays * 86400000);

  const store = getStore("credits");
  const code = await uniqueCode(store);
  const record = {
    code, amount, original: amount, reason, type, custName: (body.name || "").toString().slice(0, 80).trim(),
    singleUse: type === "courtesy",
    channel: type === "courtesy" ? "online" : "any",
    scope:   type === "courtesy" ? "openplay" : "any",
    createdAt: now.toISOString(), expiry: exp.toISOString().slice(0, 10),
    expiryDays, expiryLabel, active: true,
    history: [{ at: now.toISOString(), action: "issued", amount }],
  };
  try { await store.setJSON("credit:" + code, record); }
  catch { return json({ error: "Couldn't save the credit. Try again." }, 502); }

  const custEmail = (body.email || "").toString().slice(0, 160).trim();
  const custName = (body.name || "").toString().slice(0, 80).trim();
  let emailedCustomer = false;
  if (custEmail && /^\S+@\S+\.\S+$/.test(custEmail)) {
    emailedCustomer = await sendCredit(custEmail, record, false);
  }
  const ownerEmail = process.env.STUDIO_EMAIL || "";
  if (ownerEmail) await sendCredit(ownerEmail, record, true);

  return json({ ok: true, code, amount, expiry: record.expiry, reason, type, emailedCustomer });
};

async function sendCredit(to, rec, isOwner) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  if (!key) return false;
  const money = "$" + (rec.amount / 100).toFixed(2);
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const codeBlock = `
    <div style="text-align:center;margin:18px 0">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#8a8276;font-weight:bold">Your credit code</div>
      <div style="font-size:30px;font-weight:900;letter-spacing:2px;color:#e0584f;margin-top:4px">${esc(rec.code)}</div>
      <div style="font-size:14px;color:#5c6470;margin-top:2px">${money} · expires ${esc(rec.expiry)}</div>
    </div>`;

  let subject, html;
  if (isOwner) {
    subject = `Store credit issued: ${rec.code} (${money}, ${rec.type})`;
    html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6"><h3>Store credit issued — record copy</h3>
      <p>Type: <b>${rec.type}</b><br>Code: <b style="color:#e0584f;font-size:1.15em">${esc(rec.code)}</b><br>Amount: <b>${money}</b><br>Expires: ${esc(rec.expiry)}<br>Reason: ${esc(rec.reason) || "—"}</p></div>`;
  } else if (rec.type === "courtesy") {
    const hello = rec.custName ? `Hello ${esc(rec.custName)},` : "Hello there,";
    subject = `We missed you! A little something from ${studio}`;
    html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;line-height:1.6">
      <h2 style="color:#a85f59;font-weight:normal;margin:0 0 6px">We missed you! \u{1F49B}</h2>
      <p style="font-size:15px">${hello}</p>
      <p style="font-size:15px">We noticed your open-play visit didn't happen this time, and we completely understand \u2014 life gets busy and things come up! We'd hate for you to miss out, so we're sending a little <b>courtesy credit</b> to use on your next visit.</p>
      ${codeBlock}
      <p style="font-size:14px">Please enjoy <b>${money}</b> toward a future online booking at ${esc(studio)} \u2014 redeemable within <b>${esc(rec.expiryLabel || "30 days")}</b> (by ${esc(rec.expiry)}).</p>
      <p style="font-size:14px;margin:14px 0 4px"><b>How to redeem</b></p>
      <ol style="font-size:14px;margin:0;padding-left:20px;color:#5c6470">
        <li>Visit littlehavenplay.com and pick your open-play session</li>
        <li>At checkout, enter your code in the <b>Store Credit</b> field</li>
        <li>The credit applies automatically \u{1F388}</li>
      </ol>
      <p style="font-size:13px;color:#8a8276;margin-top:12px">One-time use \u00b7 online open-play bookings \u00b7 no cash value \u00b7 any unused balance is forfeited after redemption.</p>
      <p style="font-size:15px;margin-top:14px">We can't wait to see you and your little one soon!</p>
      <p style="margin-top:12px;background:#fcfaf6;border:1px solid #efe7da;border-radius:10px;padding:11px 13px;font-size:13px;color:#5c6470"><b>Don't see this?</b> Please check your junk/spam folder.</p>
    </div>`;
  } else {
    subject = `Your ${studio} store credit`;
    html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:520px;line-height:1.6">
      <h2 style="color:#a85f59;font-weight:normal">A store credit for you</h2>
      <p>Here is a store credit to use at ${esc(studio)}:</p>
      ${codeBlock}
      <p style="font-size:14px">Use this code at checkout when you book online, or show it to us in store. Your balance carries over until it's used up or expires.</p>
      <p style="font-size:13px;color:#8a8276">Expires ${esc(rec.expiryLabel || "30 days")} from the date of issuance (on ${esc(rec.expiry)}).</p>
      <p style="margin-top:14px;background:#fcfaf6;border:1px solid #efe7da;border-radius:10px;padding:11px 13px;font-size:13px;color:#5c6470"><b>Don't see this?</b> Please check your junk/spam folder.</p>
    </div>`;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${studio} <${from}>`, to: [to], bcc: process.env.STUDIO_EMAIL ? [process.env.STUDIO_EMAIL] : undefined, subject, html: html + SIGNATURE_HTML }),
    });
    return res.ok;
  } catch { return false; }
}

async function uniqueCode(store) {
  for (let i = 0; i < 8; i++) {
    const code = "LHC" + rand(6);
    try { const exists = await store.get("credit:" + code, { type: "json" }); if (!exists) return code; }
    catch { return code; }
  }
  return "LHC" + Date.now().toString(36).toUpperCase().slice(-6);
}
function rand(n) { const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/credit-issue" };
