// POST /api/rsvp — host-managed guest list for a party (token-authenticated via their private link).
//   { d, s, t, action:"get" }                                   -> party info + guests + reminderPref
//   { d, s, t, action:"save", guests:[{name,email}], reminderPref:"self"|"studio" } -> saves list
//   { d, s, t, action:"send-now" }                              -> emails all guests the waiver now
import { getStore } from "@netlify/blobs";
import { slotKey, WAIVER_URL } from "./lib-settings.js";

const STUDIO = "Little Haven Play Studio";
const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function loadParty(d, s, t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "") || !s) return null;
  let rec = null;
  try { rec = await getStore("parties").get(slotKey(d, s), { type: "json" }); } catch {}
  if (!rec || !rec.rsvpToken || rec.rsvpToken !== (t || "")) return null;
  return rec;
}
async function saveParty(d, s, rec) {
  try { await getStore("parties").setJSON(slotKey(d, s), rec); return true; } catch { return false; }
}

function guestEmailHtml(rec) {
  return `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6;max-width:560px">
    <h2 style="color:#a85f59;font-weight:normal">You're invited! 🎉</h2>
    <p>You're invited to <b>${esc(rec.childName)}'s birthday party</b> at ${STUDIO}${rec.date ? " on <b>" + esc(rec.date) + "</b>" : ""}${rec.slotLabel ? " at " + esc(rec.slotLabel) : ""}!</p>
    <div style="background:#f3f0ff;border-radius:12px;padding:14px 16px;margin:14px 0">
      <p style="margin:0 0 8px;font-weight:bold;color:#5b4636">⭐ Please sign the waiver before you arrive</p>
      <p style="margin:0 0 10px;color:#5c6470;font-size:14px">Every guest needs a signed waiver to play — signing ahead saves time at the door.</p>
      <a href="${WAIVER_URL}" style="display:inline-block;background:#7a6253;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:10px">Sign the waiver →</a>
    </div>
    <p style="color:#5c6470;font-size:13px">See you there! — ${STUDIO}</p></div>`;
}

async function emailGuests(rec) {
  const key = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM || "onboarding@resend.dev", studioEmail = process.env.STUDIO_EMAIL;
  if (!key || !Array.isArray(rec.guests)) return 0;
  let sent = 0;
  for (const g of rec.guests) {
    const to = (g.email || "").toString().trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) continue;
    try {
      await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${STUDIO} <${from}>`, to: [to], bcc: studioEmail ? [studioEmail] : undefined, reply_to: rec.email || undefined,
          subject: `You're invited to ${rec.childName}'s party! 🎈`, html: guestEmailHtml(rec) }) });
      sent++;
    } catch {}
  }
  return sent;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const d = (b.d || "").toString(), s = (b.s || "").toString(), t = (b.t || "").toString();
  const rec = await loadParty(d, s, t);
  if (!rec) return json({ error: "This guest-list link isn't valid. Please contact us at hello@littlehavenplay.com." }, 403);
  const action = (b.action || "get").toString();

  if (action === "save") {
    const guests = Array.isArray(b.guests) ? b.guests.slice(0, 80).map(g => ({
      name: (g.name || "").toString().slice(0, 80).trim(),
      email: (g.email || "").toString().slice(0, 160).trim(),
    })).filter(g => g.name || g.email) : [];
    rec.guests = guests;
    rec.reminderPref = b.reminderPref === "studio" ? "studio" : "self";
    if (!(await saveParty(d, s, rec))) return json({ error: "Couldn't save. Try again." }, 502);
    return json({ ok: true, count: guests.length });
  }
  if (action === "send-now") {
    const sent = await emailGuests(rec);
    rec.guestsEmailedAt = new Date().toISOString();
    await saveParty(d, s, rec);
    return json({ ok: true, sent });
  }
  return json({
    ok: true, childName: rec.childName || "", date: rec.date || "", slotLabel: rec.slotLabel || "",
    packageLabel: rec.packageLabel || "", guests: Array.isArray(rec.guests) ? rec.guests : [],
    reminderPref: rec.reminderPref || "self", waiverUrl: WAIVER_URL,
  });
};
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
export const config = { path: "/api/rsvp" };
