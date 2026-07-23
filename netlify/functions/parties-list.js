// POST /api/parties-list  (admin key or staff PIN)
//   { key }                              -> all parties, chronological (soonest first)
//   { key, action:"mark-paid", date, partySlot, paid } -> toggle deposit paid
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import { slotKey, WAIVER_URL } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "", provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("parties");

  if ((b.action || "") === "mark-paid") {
    const k = slotKey((b.date || "").toString(), (b.partySlot || "").toString());
    let r = null;
    try { r = await store.get(k, { type: "json" }); } catch {}
    if (!r) return json({ error: "Party not found." }, 404);
    r.depositPaid = !!b.paid;
    if (r.depositPaid && r.status === "pending-deposit") r.status = "deposit-paid";
    try { await store.setJSON(k, r); } catch { return json({ error: "Couldn't save. Try again." }, 502); }
    if (b.paid) { try { await emailConfirmed(r); } catch {} }
    return json({ ok: true });
  }

  let keys = [];
  try { const r = await store.list(); keys = (r.blobs || []).map(x => x.key); } catch {}
  const parties = [];
  for (const k of keys) {
    try {
      const r = await store.get(k, { type: "json" });
      if (!r || !r.date || !r.partySlot) continue;
      parties.push({
        date: r.date, partySlot: r.partySlot, slotLabel: r.slotLabel || "",
        package: r.packageLabel || r.package || "", deposit: r.deposit || 0,
        childName: r.childName || "", name: r.name || "", phone: r.phone || "", email: r.email || "",
        kids: r.kids || null, adults: r.adults || null,
        status: r.status || "", depositPaid: !!r.depositPaid, at: r.at || "",
      });
    } catch {}
  }
  parties.sort((a, c) => (a.date + a.partySlot).localeCompare(c.date + c.partySlot));
  return json({ ok: true, parties, count: parties.length });
};
async function emailConfirmed(r) {
  const key = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM || "onboarding@resend.dev", studioEmail = process.env.STUDIO_EMAIL;
  const studio = "Little Haven Play Studio";
  if (!key || !r || !r.email) return;
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6;max-width:540px">
    <h2 style="color:#a85f59;font-weight:normal">Your party is confirmed! 🎉</h2>
    <p>Hi ${esc(r.name)}, your deposit is in and ${esc(r.childName) ? esc(r.childName) + "'s" : "your"} party is officially booked for <b>${esc(r.date)} · ${esc(r.slotLabel)}</b> (${esc(r.packageLabel || r.package)}). We can't wait to celebrate! 🎂</p>
    <div style="background:#f3f0ff;border-radius:12px;padding:14px 16px;margin:14px 0">
      <p style="margin:0 0 6px;font-weight:bold;color:#5b4636">📋 Don't forget the waiver!</p>
      <p style="margin:0 0 10px;color:#5c6470;font-size:14px">Every guest must sign before arrival to avoid delays. Please forward this link to all your guests:</p>
      <a href="${WAIVER_URL}" style="display:inline-block;background:#7a6253;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:10px">Sign the waiver →</a>
    </div>
    <p style="color:#5c6470;font-size:13px">Reply anytime or message @littlehavenplay. — ${studio}</p></div>`;
  await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `${studio} <${from}>`, to: [r.email], bcc: studioEmail ? [studioEmail] : undefined, subject: `Your party is confirmed — ${r.date}`, html: html + SIGNATURE_HTML }) });
}
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
export const config = { path: "/api/parties-list" };
