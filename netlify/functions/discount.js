// POST /api/discount
// One-time, percent-off discount codes. Cannot be combined with any other offer.
//   { key, action:"create", percent, email, name?, label?, expiryDays? }  (admin/staff)
//   { code, action:"check" }                                               (public — for the booking page)
//   { key, action:"lookup", code }                                         (admin/staff — owner copy/verify)
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import { STUDIO_NAME } from "./lib-settings.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no ambiguous 0/O/1/I/L

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = (b.action || "").toString();
  const store = getStore("discounts");

  // ---- PUBLIC: validate a code for the booking page (no key, no PII returned) ----
  if (action === "check") {
    const code = normalize(b.code);
    if (!code) return json({ valid: false, message: "Enter a code." });
    const rec = await getRec(store, code);
    const v = validity(rec);
    if (!v.ok) return json({ valid: false, message: v.message });
    return json({ valid: true, code, percent: rec.percent });
  }

  // ---- Everything else requires admin key or staff PIN ----
  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  if (action === "lookup") {
    const code = normalize(b.code);
    const rec = await getRec(store, code);
    if (!rec) return json({ error: "Code not found." }, 404);
    return json({ ok: true, record: rec, summary: summarize(rec) });
  }

  if (action === "deactivate") {
    const code = normalize(b.code);
    const rec = await getRec(store, code);
    if (!rec) return json({ error: "Code not found." }, 404);
    if (!rec.active) return json({ ok: true, code, type: "Discount", alreadyOff: true, message: "That discount code was already deactivated." });
    rec.active = false;
    rec.deactivatedAt = new Date().toISOString();
    try { await store.setJSON("disc:" + code, rec); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, code, type: "Discount", message: "Discount code deactivated — it can no longer be used at checkout." });
  }

  if (action === "create") {
    const percent = parseInt(b.percent, 10);
    if (!Number.isFinite(percent) || percent < 1 || percent > 100)
      return json({ error: "Enter a discount between 1% and 100%." }, 400);
    const email = (b.email || "").toString().trim().slice(0, 160);
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter the customer's email so we can send them the code." }, 400);
    const name = (b.name || "").toString().trim().slice(0, 120);
    const label = (b.label || "").toString().trim().slice(0, 80);
    let expiryDays = parseInt(b.expiryDays, 10);
    if (!Number.isFinite(expiryDays) || expiryDays < 1) expiryDays = 90;
    expiryDays = Math.min(expiryDays, 365);
    const expiry = new Date(Date.now() + expiryDays * 86400000).toISOString().slice(0, 10);

    // Generate a unique code
    let code = "";
    for (let i = 0; i < 6; i++) {
      code = "LH" + Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
      const existing = await getRec(store, code);
      if (!existing) break;
      code = "";
    }
    if (!code) return json({ error: "Couldn't generate a unique code. Try again." }, 502);

    const rec = {
      code, percent, email, name, label,
      active: true, used: false, usedAt: null, usedBy: null, bookingId: null,
      expiry, createdAt: new Date().toISOString(),
    };
    try { await store.setJSON("disc:" + code, rec); }
    catch { return json({ error: "Couldn't save the code. Try again." }, 502); }

    const emailed = await emailCode({ email, name, code, percent, expiry });

    return json({
      ok: true, code, percent, email, expiry, emailed,
      message: `Created ${percent}% off code ${code} for ${email}${emailed ? " and emailed it to them." : " (email not sent — check email settings)."}`,
      summary: summarize(rec),
    });
  }

  return json({ error: "Unknown action." }, 400);
};

function normalize(c) { return (c || "").toString().trim().toUpperCase().replace(/\s+/g, ""); }

async function getRec(store, code) {
  if (!code) return null;
  try { return await store.get("disc:" + code, { type: "json" }); } catch { return null; }
}

function validity(rec) {
  if (!rec) return { ok: false, message: "That code wasn't found." };
  if (!rec.active) return { ok: false, message: "This discount code is no longer active." };
  if (rec.used) return { ok: false, message: "That code has already been used." };
  if (rec.expiry && rec.expiry < new Date().toISOString().slice(0, 10)) return { ok: false, message: "That code has expired." };
  return { ok: true };
}

function summarize(rec) {
  const status = rec.used ? `USED on ${(rec.usedAt || "").slice(0, 10)}${rec.usedBy ? " by " + rec.usedBy : ""}`
    : (rec.expiry && rec.expiry < new Date().toISOString().slice(0, 10)) ? "EXPIRED" : "Active (not yet used)";
  return `${rec.code} — ${rec.percent}% off · ${rec.email} · expires ${rec.expiry} · ${status}`;
}

// Emails the customer their code (best-effort). BCCs the studio so the owner has a copy.
async function emailCode({ email, name, code, percent, expiry }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !email) return false;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:520px;margin:0 auto;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 6px">A little treat from ${STUDIO_NAME} 💛</h2>
    <p style="margin:0 0 14px;color:#5c6470">Hi${name ? " " + name : ""}, here's <b>${percent}% off</b> your next Open Play visit:</p>
    <div style="background:#fdf1ec;border:2px dashed #c97d76;border-radius:14px;padding:18px;text-align:center;margin:0 0 16px">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a85f59;font-weight:bold">Your code</div>
      <div style="font-size:30px;letter-spacing:.06em;font-weight:bold;color:#2a2622;margin-top:4px">${code}</div>
      <div style="font-size:13px;color:#8a8276;margin-top:6px">${percent}% off · valid through ${expiry}</div>
    </div>
    <p style="margin:0 0 8px;font-size:14px;color:#5c6470">To use it, book Open Play online and enter the code at checkout.</p>
    <ul style="margin:0 0 14px;padding-left:18px;font-size:13px;color:#8a8276">
      <li>One-time use</li>
      <li>Redeemable online only</li>
      <li>Cannot be combined with any other offer (gift cards, store credit, or punch cards)</li>
    </ul>
    <a href="${process.env.SITE_URL || "https://littlehavenplay.com"}/book.html" style="display:inline-block;background:#c97d76;color:#fff;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:.04em;text-transform:uppercase;padding:11px 22px;border-radius:40px">Book your visit</a>
    <p style="margin:18px 0 0;font-size:13px;color:#aea298">We can't wait to see you! 💛</p>
  </div>`;
  const text = `A treat from ${STUDIO_NAME}!\n\n${percent}% off your next Open Play visit.\nCode: ${code}\nValid through ${expiry}\n\n`
    + `How to use: book Open Play online and enter the code at checkout.\n- One-time use\n- Online only\n- Cannot be combined with any other offer.\n\nBook: ${(process.env.SITE_URL || "https://littlehavenplay.com")}/book.html`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${STUDIO_NAME} <${from}>`,
        to: [email], bcc: bcc ? [bcc] : undefined,
        subject: `Your ${percent}% off code for ${STUDIO_NAME} 💛`,
        html, text,
      }),
    });
    return r.ok;
  } catch { return false; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/discount" };
