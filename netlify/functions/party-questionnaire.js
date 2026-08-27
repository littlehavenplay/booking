// POST /api/party-questionnaire — saves a party's preferences to its record and emails owner + customer.
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML, fromHeader } from "./lib-email.js";
import { slotKey } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const date = (b.date || "").toString().trim();
  const partySlot = (b.partySlot || "").toString().trim();
  const pkgLabel = (b.packageLabel || b.package || "").toString().slice(0, 60);
  const name = (b.name || "").toString().slice(0, 120).trim();
  const email = (b.email || "").toString().slice(0, 160).trim();
  const comments = (b.comments || "").toString().slice(0, 4000).trim();
  const items = Array.isArray(b.items) ? b.items.slice(0, 30).map(x => ({
    label: (x && x.label || "").toString().slice(0, 80),
    value: (x && x.value || "").toString().slice(0, 200),
  })).filter(x => x.label) : [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !partySlot) return json({ error: "Missing party details." }, 400);

  // Save onto the party record.
  try {
    const store = getStore("parties");
    const key = slotKey(date, partySlot);
    const rec = await store.get(key, { type: "json" });
    if (rec) {
      rec.preferences = { items, comments };
      rec.preferencesAt = new Date().toISOString();
      await store.setJSON(key, rec);
    }
  } catch {}

  const key = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM || "onboarding@resend.dev", studioEmail = process.env.STUDIO_EMAIL;
  const studio = "Little Haven Play Studio";
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  const rows = items.map(i => `<tr><td style="padding:4px 14px 4px 0;color:#5c6470">${esc(i.label)}</td><td style="padding:4px 0;font-weight:bold">${esc(i.value) || "—"}</td></tr>`).join("");

  // Owner copy
  if (key && studioEmail) {
    const html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6">
      <h2 style="color:#a85f59">Party preferences received 🎈</h2>
      <p style="margin:0 0 8px">${esc(pkgLabel)} — ${esc(name)} · ${esc(date)}</p>
      <table style="border-collapse:collapse;font-size:15px">${rows}</table>
      ${comments ? `<p style="margin-top:12px"><b>Comments / questions:</b><br>${esc(comments)}</p>` : ""}</div>`;
    try {
      await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromHeader(from, studio), to: [studioEmail], reply_to: email || undefined, subject: `Party preferences — ${name} (${date})`, html: html + SIGNATURE_HTML }) });
    } catch {}
  }
  // Customer copy
  if (key && email) {
    const html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6;max-width:540px">
      <h2 style="color:#a85f59;font-weight:normal">Thanks — we've got your party preferences! 🎉</h2>
      <p>Hi ${esc(name)}, here's what we have for your ${esc(pkgLabel)} on ${esc(date)}:</p>
      <table style="border-collapse:collapse;font-size:15px">${rows}</table>
      ${comments ? `<p style="margin-top:12px"><b>Your notes:</b><br>${esc(comments)}</p>` : ""}
      <p style="color:#5c6470;font-size:14px;margin-top:14px">We'll be in touch to finalize the details. Reply anytime or message @littlehavenplay.</p>
      <p style="color:#5c6470;font-size:13px">— ${studio}</p></div>`;
    try {
      await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromHeader(from, studio), to: [email], bcc: studioEmail ? [studioEmail] : undefined, subject: `Your party preferences — ${studio}`, html: html + SIGNATURE_HTML }) });
    } catch {}
  }
  return json({ ok: true });
};
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
export const config = { path: "/api/party-questionnaire" };
