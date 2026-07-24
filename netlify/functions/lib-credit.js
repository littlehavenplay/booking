// Shared store-credit issuing logic — used by reschedule.js (manual staff
// cancellations) and noshow-cron.js (automatic no-show credits), so there's
// exactly ONE place that creates a credit code, formats its email, and
// notifies the studio. Previously this lived duplicated/private inside
// reschedule.js only.
import { getStore } from "@netlify/blobs";
import { STUDIO_NAME } from "./lib-settings.js";
import { SIGNATURE_HTML } from "./lib-email.js";

// expiryDays: optional override (e.g. 15 for a no-show credit, or a staff-chosen
// value from the Issue Credit tool). Defaults to CREDIT_EXPIRY_MONTHS (3 months) when omitted.
export async function makeCredit(type, amountCents, reason, opts = {}) {
  const store = getStore("credits");
  const code = await uniqueCreditCode(store);
  const now = new Date();
  let exp, expiryDays = opts.expiryDays || null;
  if (expiryDays) {
    exp = new Date(now.getTime() + expiryDays * 86400000);
  } else {
    const months = parseInt(process.env.CREDIT_EXPIRY_MONTHS || "3", 10);
    exp = new Date(now); exp.setMonth(exp.getMonth() + months);
    expiryDays = Math.round((exp - now) / 86400000);
  }
  const expiryLabel = expiryDays >= 365 ? "1 year" : expiryDays >= 180 ? "6 months" : (expiryDays + " days");
  const rec = {
    code, amount: amountCents, original: amountCents, reason, type,
    custName: (opts.custName || "").toString().slice(0, 80).trim(),
    singleUse: type === "courtesy",
    channel: type === "courtesy" ? "online" : "any",
    scope: type === "courtesy" ? "openplay" : "any",
    createdAt: now.toISOString(), expiry: exp.toISOString().slice(0, 10), expiryDays, expiryLabel, active: true,
    customIntro: opts.customIntro || null,   // optional friendly intro line for the customer email
    history: [{ at: now.toISOString(), action: "issued", amount: amountCents }],
  };
  try { await store.setJSON("credit:" + code, rec); return rec; } catch { return null; }
}

export async function ownerCopy(rec) {
  const ownerEmail = process.env.STUDIO_EMAIL || "";
  if (ownerEmail) { try { await sendCreditEmail(ownerEmail, rec, true); } catch {} }
}

export async function uniqueCreditCode(store) {
  for (let i = 0; i < 8; i++) {
    const code = "LHC" + randCode(6);
    try { const exists = await store.get("credit:" + code, { type: "json" }); if (!exists) return code; }
    catch { return code; }
  }
  return "LHC" + Date.now().toString(36).toUpperCase().slice(-6);
}
function randCode(n) { const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

// How many days until expiry, for accurate email copy regardless of a custom expiryDays override.
function daysUntil(dateStr) {
  const d = Math.round((new Date(dateStr + "T12:00:00") - new Date()) / 86400000);
  return d;
}

export async function sendCreditEmail(to, rec, isOwner) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studio = STUDIO_NAME || "Little Haven Play Studio";
  if (!key) return false;
  const money = "$" + (rec.amount / 100).toFixed(2);
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const days = daysUntil(rec.expiry);
  const expiryLine = days > 0 && days <= 20 ? `Expires ${esc(rec.expiry)} (${days} day${days === 1 ? "" : "s"} from now)` : `Expires ${esc(rec.expiry)}`;
  const codeBlock = `
    <div style="text-align:center;margin:18px 0">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#8a8276;font-weight:bold">Your credit code</div>
      <div style="font-size:30px;font-weight:900;letter-spacing:2px;color:#e0584f;margin-top:4px">${esc(rec.code)}</div>
      <div style="font-size:14px;color:#5c6470;margin-top:2px">${money} · ${expiryLine}</div>
    </div>`;
  let subject, html;
  if (isOwner) {
    subject = `Store credit issued: ${rec.code} (${money}, ${rec.type})`;
    html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6"><h3>Store credit issued — record copy</h3>
      <p>Type: <b>${rec.type}</b><br>Code: <b style="color:#e0584f;font-size:1.15em">${esc(rec.code)}</b><br>Amount: <b>${money}</b><br>Expires: ${esc(rec.expiry)}<br>Reason: ${esc(rec.reason) || "—"}</p></div>`;
  } else if (rec.type === "courtesy") {
    const hello = rec.custName ? `Hello ${esc(rec.custName)},` : "Hello there,";
    const intro = rec.customIntro || "We noticed your open-play visit didn't happen this time, and we completely understand — life gets busy and things come up! We'd hate for you to miss out, so we're sending a little courtesy credit to use on your next visit.";
    subject = `A courtesy credit from ${studio}`;
    html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;line-height:1.6">
      <h2 style="color:#a85f59;font-weight:normal;margin:0 0 6px">A little something for you 💛</h2>
      <p style="font-size:15px">${hello}</p>
      <p style="font-size:15px">${intro}</p>
      ${codeBlock}
      <p style="font-size:14px">Please enjoy <b>${money}</b> toward a future online open-play booking at ${esc(studio)} — redeemable within <b>${esc(rec.expiryLabel || "30 days")}</b> (by ${esc(rec.expiry)}).</p>
      <p style="font-size:14px;margin:14px 0 4px"><b>How to redeem</b></p>
      <ol style="font-size:14px;margin:0;padding-left:20px;color:#5c6470">
        <li>Visit littlehavenplay.com and pick your open-play session</li>
        <li>At checkout, enter your code in the <b>Store Credit</b> field</li>
        <li>The credit applies automatically 🎈</li>
      </ol>
      <p style="font-size:13px;color:#8a8276;margin-top:12px">One-time use · online open-play bookings only · no cash value · any unused balance is forfeited after redemption.</p>
      <p style="font-size:15px;margin-top:14px">We can't wait to see you and your little one soon!</p>
      <p style="margin-top:12px;background:#fcfaf6;border:1px solid #efe7da;border-radius:10px;padding:11px 13px;font-size:13px;color:#5c6470"><b>Don't see this?</b> Please check your junk/spam folder.</p>
    </div>`;
  } else {
    subject = `Your ${studio} store credit`;
    html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:520px;line-height:1.6">
      <h2 style="color:#a85f59;font-weight:normal">A store credit for you</h2>
      ${rec.customIntro ? `<p>${rec.customIntro}</p>` : `<p>Here is a store credit to use at ${esc(studio)}:</p>`}
      ${codeBlock}
      <p style="font-size:14px">Use this code at checkout when you book online, or show it to us in store. Your balance carries over until it's used up or expires.</p>
      <p style="font-size:13px;color:#8a8276">${expiryLine}.</p>
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
