// Scheduled daily — emails every host whose party is TOMORROW a "big day" reminder + waiver nudge.
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import { WAIVER_URL } from "./lib-settings.js";
import { eventPacificParts } from "./lib-closures.js";

export default async () => {
  const key = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM || "onboarding@resend.dev", studioEmail = process.env.STUDIO_EMAIL;
  const studio = "Little Haven Play Studio";
  if (!key) return new Response("No email configured.", { status: 200 });

  const todayPac = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD
  const t = new Date(todayPac + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + 1);
  const tomorrow = t.toISOString().slice(0, 10);

  const store = getStore("parties");
  let keys = []; try { const r = await store.list(); keys = (r.blobs || []).map(x => x.key); } catch {}
  let sent = 0;
  for (const k of keys) {
    try {
      const r = await store.get(k, { type: "json" });
      if (!r || r.date !== tomorrow || !r.email) continue;
      const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6;max-width:560px">
        <h2 style="color:#a85f59;font-weight:normal">Tomorrow's the big day! 🎉</h2>
        <p>Hi ${esc(r.name)}, we can't wait to celebrate ${esc(r.childName)}'s birthday with you tomorrow${r.slotLabel ? " at " + esc(r.slotLabel) : ""}!</p>
        <div style="background:#f3f0ff;border-radius:12px;padding:14px 16px;margin:14px 0">
          <p style="margin:0 0 6px;font-weight:bold;color:#5b4636">⭐ One quick thing — the waiver</p>
          <p style="margin:0 0 10px;color:#5c6470;font-size:14px">Please make sure <b>every guest signs the waiver before arrival</b> so there are no delays at your party. Forward this link to all your guests:</p>
          <a href="${WAIVER_URL}" style="display:inline-block;background:#7a6253;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:10px">Sign the waiver →</a>
        </div>
        <p style="color:#5c6470;font-size:13px">See you soon! Reply or message @littlehavenplay with any last-minute questions. — ${studio}</p></div>`;
      await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${studio} <${from}>`, to: [r.email], bcc: studioEmail ? [studioEmail] : undefined, subject: `Tomorrow's the big day — ${r.childName}'s party! 🎈`, html: html + SIGNATURE_HTML }) });
      sent++;
    } catch {}
  }
  // ---- Open-play bookings happening tomorrow ----
  try {
    const bStore = getStore("bookings");
    let bkeys = []; try { const r = await bStore.list({ prefix: tomorrow + "__" }); bkeys = (r.blobs || []).map(x => x.key); } catch {}
    for (const k of bkeys) {
      try {
        const blob = await bStore.get(k, { type: "json" });
        for (const bk of (blob?.bookings || [])) {
          if (!bk.email) continue;
          const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6;max-width:560px">
            <h2 style="color:#a85f59;font-weight:normal">See you tomorrow! 🌿</h2>
            <p>Hi ${esc(bk.name || "there")}, this is a friendly reminder that your visit to ${studio} is <b>tomorrow</b>. We can't wait to see you!</p>
            <div style="background:#f3f0ff;border-radius:12px;padding:12px 15px;margin:12px 0">
              <p style="margin:0 0 8px;font-size:14px;color:#5c6470">Please make sure <b>everyone in your group has signed the waiver</b> before you arrive so check-in is quick:</p>
              <a href="${WAIVER_URL}" style="display:inline-block;background:#7a6253;color:#fff;text-decoration:none;font-weight:bold;padding:9px 16px;border-radius:10px">Sign the waiver →</a>
            </div>
            <p style="color:#5c6470;font-size:13px">Need to change your visit? Just reply or message @littlehavenplay. See you soon! — ${studio}</p></div>`;
          await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: `${studio} <${from}>`, to: [bk.email], bcc: studioEmail ? [studioEmail] : undefined, subject: `See you tomorrow at ${studio}! 🎈`, html: html + SIGNATURE_HTML }) });
          sent++;
        }
      } catch {}
    }
  } catch {}

  // ---- Ticketed events happening tomorrow ----
  try {
    const eStore = getStore("events");
    let ekeys = []; try { const r = await eStore.list({ prefix: "event:" }); ekeys = (r.blobs || []).map(x => x.key); } catch {}
    for (const k of ekeys) {
      try {
        const ev = await eStore.get(k, { type: "json" });
        if (!ev || !ev.dateTime) continue;
        const parts = eventPacificParts(ev.dateTime);   // read the event's time as Pacific
        if (!parts || parts.date !== tomorrow) continue;
        const when = `${parts.weekday} at ${parts.timeLabel}`;   // e.g. "Saturday at 5:00 PM"
        for (const buyer of (ev.buyers || [])) {
          if (!buyer.email) continue;
          const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const waivers = (ev.waiverLink || ev.regularWaiverLink) ? `<div style="background:#fdf7f0;border:1px solid #ecdcc9;border-radius:12px;padding:12px 15px;margin:12px 0">
            <p style="margin:0 0 8px;font-size:14px;color:#5c6470"><b>Please complete the required waiver(s) before the event</b> (both, unless already signed):</p>
            ${ev.waiverLink ? `<a href="${esc(ev.waiverLink)}" style="display:inline-block;background:#a85f59;color:#fff;text-decoration:none;font-weight:bold;padding:9px 15px;border-radius:22px;margin:3px 6px 3px 0">Event waiver →</a>` : ""}
            ${ev.regularWaiverLink ? `<a href="${esc(ev.regularWaiverLink)}" style="display:inline-block;background:#7ba676;color:#fff;text-decoration:none;font-weight:bold;padding:9px 15px;border-radius:22px;margin:3px 0">General waiver →</a>` : ""}
          </div>` : "";
          const html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6;max-width:560px">
            <h2 style="color:#a85f59;font-weight:normal">${esc(ev.title)} is tomorrow! 🎉</h2>
            <p>Hi ${esc(buyer.name || "there")}, just a reminder that <b>${esc(ev.title)}</b> is tomorrow (${esc(when)}). We're looking forward to it!</p>
            ${waivers}
            <p style="color:#5c6470;font-size:13px">Questions? Reply or message @littlehavenplay. — ${studio}</p></div>`;
          await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: `${studio} <${from}>`, to: [buyer.email], bcc: studioEmail ? [studioEmail] : undefined, subject: `Reminder: ${ev.title} is tomorrow!`, html: html + SIGNATURE_HTML }) });
          sent++;
        }
      } catch {}
    }
  } catch {}

  return new Response("Reminders sent: " + sent, { status: 200 });
};
// 10am Pacific (17:00 UTC during PDT). Runs daily.
export const config = { schedule: "0 17 * * *" };
