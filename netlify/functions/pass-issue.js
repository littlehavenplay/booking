// POST /api/pass-issue  (admin key or staff PIN)
// Mint a punch card code by hand (e.g. for an in-store purchase or to make a
// customer whole). Behaves exactly like a purchased pass: each visit covers a
// matching admission at $0 (so no tax) plus one adult.
// Body: { key, passId, visitsRemaining?, childName, name, phone, email, dobMonth?, dobYear?, sendEmail? }
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import { PASSES, STUDIO_NAME, passExpiryDate } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  // ---- Fix / correct a card ----
  // Sets the EXACT visits remaining (not additive) and refreshes the expiry to a
  // valid future date. Use this to undo a mistaken reload or repair a bad expiry.
  const fixCode = (b.fixCode || "").toString().trim().toUpperCase();
  if (fixCode) {
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
  }

  // ---- In-person reload: top up an EXISTING card, keep the same code ----
  // Staff collect payment via the POS, then roll new visits onto the existing
  // code (added on top of whatever's left). No Square charge happens here.
  const reloadCode = (b.reloadCode || "").toString().trim().toUpperCase();
  if (reloadCode) {
    const store0 = getStore("passes");
    let rec = null;
    try { rec = await store0.get("pass:" + reloadCode, { type: "json" }); } catch { rec = null; }
    if (!rec) return json({ error: "That punch card code wasn't found." }, 404);
    const targetId = rec.admission === "infant" ? "I8" : rec.admission === "sibling" ? "S8" : "R8";
    const t = PASSES[targetId];
    const addVisits = (Number.isFinite(parseInt(b.visitsRemaining, 10)) && parseInt(b.visitsRemaining, 10) > 0)
      ? parseInt(b.visitsRemaining, 10) : t.visits;
    const now0 = new Date();
    const exp0 = passExpiryDate(now0, t.expiryMonths, rec.admission, rec.dobMonth, rec.dobYear);
    rec.visitsRemaining = Math.max(0, rec.visitsRemaining || 0) + addVisits;
    rec.visits = t.visits; rec.passId = targetId; rec.label = t.label;
    rec.active = true; rec.expiry = exp0.toISOString().slice(0, 10);
    rec.lastReloadAt = now0.toISOString(); rec.reloadCount = (rec.reloadCount || 0) + 1;
    rec.reminderSentAt = null;
    try { await store0.setJSON("pass:" + reloadCode, rec); }
    catch { return json({ error: "Couldn't update the card. Try again." }, 502); }
    return json({ ok: true, reloaded: true, code: reloadCode, label: rec.label,
      addedVisits: addVisits, visitsRemaining: rec.visitsRemaining, expiry: rec.expiry });
  }

  const passId = (b.passId || "").toString();
  const p = PASSES[passId];
  if (!p) return json({ error: "Pick a valid punch card type." }, 400);

  const childName = (b.childName || "").toString().slice(0, 80).trim();
  const name = (b.name || "").toString().slice(0, 120).trim();
  const phone = (b.phone || "").toString().slice(0, 40).trim();
  const email = (b.email || "").toString().slice(0, 160).trim();
  if (!name) return json({ error: "Enter the customer's name." }, 400);

  let visitsRemaining = parseInt(b.visitsRemaining, 10);
  if (!Number.isFinite(visitsRemaining) || visitsRemaining < 1) visitsRemaining = p.visits;
  if (visitsRemaining > p.visits) visitsRemaining = p.visits;

  const store = getStore("passes");
  const now = new Date();
  const dobMonth = parseInt(b.dobMonth, 10) || null;
  const dobYear = parseInt(b.dobYear, 10) || null;
  const expiryDate = passExpiryDate(now, p.expiryMonths, p.admission, dobMonth, dobYear);

  const code = await uniqueCode(store, name, phone, p.typeNum);
  const record = {
    code, passId, label: p.label, admission: p.admission,
    visits: p.visits, visitsRemaining,
    childName, dobMonth, dobYear,
    buyerName: name, buyerEmail: email, buyerPhone: phone,
    purchaseDate: now.toISOString(), expiry: expiryDate.toISOString().slice(0, 10),
    active: true, issuedByAdmin: true, paymentId: "issued-admin",
  };
  try { await store.setJSON("pass:" + code, record); }
  catch { return json({ error: "Couldn't save the pass. Try again." }, 502); }

  let emailed = false;
  if (b.sendEmail && email && /^\S+@\S+\.\S+$/.test(email)) {
    emailed = await sendPassEmail({ email, name, code, label: p.label, visitsRemaining, expiry: record.expiry, childName });
  }

  return json({ ok: true, code, label: p.label, visitsRemaining, expiry: record.expiry, emailed });
};

async function uniqueCode(store, name, phone, typeNum) {
  const parts = (name || "X").trim().split(/\s+/);
  const fi = (parts[0]?.[0] || "X").toUpperCase();
  const li = (parts[parts.length - 1]?.[0] || "X").toUpperCase();
  const last4 = (phone.replace(/\D/g, "").slice(-4) || "0000").padStart(4, "0");
  const base = `${fi}${li}${last4}-${typeNum}`;
  for (let i = 0; i < 6; i++) {
    const code = i === 0 ? base : `${base}${randChar()}${randChar()}`;
    try { const exists = await store.get("pass:" + code, { type: "json" }); if (!exists) return code; }
    catch { return code; }
  }
  return `${base}${Date.now().toString(36).slice(-3).toUpperCase()}`;
}
function randChar() { const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return c[Math.floor(Math.random() * c.length)]; }

async function sendPassEmail({ email, name, code, label, visitsRemaining, expiry, childName }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  if (!key) return false;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:520px;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal">Your ${STUDIO_NAME} punch card 🎟️</h2>
    <p>Hi ${esc(name)}, here is your punch card code${childName ? " for " + esc(childName) : ""}:</p>
    <div style="background:#fdf1ec;border-radius:12px;padding:16px;text-align:center;margin:12px 0">
      <div style="font-size:13px;color:#a85f59;font-weight:bold">${esc(label)}</div>
      <div style="font-size:26px;font-weight:bold;letter-spacing:2px;margin:6px 0">${esc(code)}</div>
      <div style="font-size:13px;color:#5c6470">${visitsRemaining} visit${visitsRemaining === 1 ? "" : "s"} remaining · expires ${esc(expiry)}</div>
    </div>
    <p>Use this code at checkout when you book Open Play online, or just show it to us in store. Each visit covers one admission (no extra charge or tax) plus one adult.</p>
    <p style="margin-top:14px;background:#fcfaf6;border:1px solid #efe7da;border-radius:10px;padding:11px 13px;font-size:13px;color:#5c6470"><b>📩 Don't see this email?</b> Please check your junk/spam folder and mark it "not spam."</p>
    <p style="margin-top:12px">See you soon at ${STUDIO_NAME}!</p>
  </div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${STUDIO_NAME} <${from}>`, to: [email], bcc: process.env.STUDIO_EMAIL ? [process.env.STUDIO_EMAIL] : undefined, subject: `Your ${STUDIO_NAME} punch card code`, html: html + SIGNATURE_HTML }),
    });
    return res.ok;
  } catch { return false; }
}
function esc(s) { return (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/pass-issue" };
