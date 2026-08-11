// /api/event-waitlist
//   PUBLIC join:  POST { eventId, name, email, phone, count }
//   ADMIN (key/pin) list:   POST { key, action:"list",   eventId }
//   ADMIN notify:           POST { key, action:"notify", eventId }   -> emails everyone not yet notified
//   ADMIN remove:           POST { key, action:"remove", eventId, id }
// Stored in the "waitlist" store, one array per event under "wait:<eventId>".
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import { STUDIO_NAME } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const eventId = (b.eventId || "").toString();
  if (!eventId) return json({ error: "Missing event." }, 400);

  const store = getStore("waitlist");
  const key = "wait:" + eventId;
  const action = (b.action || "join").toString();

  // ---------- Admin actions ----------
  if (action === "list" || action === "notify" || action === "remove") {
    const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
    const provided = (b.key || "").toString();
    if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
    if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

    let list = [];
    try { list = (await store.get(key, { type: "json" })) || []; } catch { list = []; }

    if (action === "list") return json({ ok: true, waitlist: list });

    if (action === "remove") {
      const id = (b.id || "").toString();
      const next = list.filter(x => x.id !== id);
      try { await store.setJSON(key, next); } catch { return json({ error: "Couldn't save. Try again." }, 502); }
      return json({ ok: true, waitlist: next, message: "Removed from the waitlist." });
    }

    // notify: email everyone not yet notified that a spot may have opened
    let ev = null;
    try { ev = await getStore("events").get("event:" + eventId, { type: "json" }); } catch {}
    const title = (ev && ev.title) || "our event";
    const rkey = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM || "onboarding@resend.dev", bcc = process.env.STUDIO_EMAIL || null;
    let sent = 0;
    if (rkey) {
      for (const w of list) {
        if (w.notified || !w.email) continue;
        const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6;max-width:560px">
          <h2 style="color:#a85f59;font-weight:normal">A spot just opened! 🎉</h2>
          <p>Hi ${esc(w.name || "there")}, good news — a space has opened up for <b>${esc(title)}</b>, and you're on our waitlist.</p>
          <p>Spots go quickly, so if you'd still like to come, please register as soon as you can:</p>
          <p><a href="https://littlehavenplay.com/events.html" style="display:inline-block;background:#a85f59;color:#fff;text-decoration:none;font-weight:bold;padding:10px 20px;border-radius:22px">Grab your spot →</a></p>
          <p style="color:#5c6470;font-size:13px">If it's already filled again by the time you get here, we're sorry we missed you — and we'll keep you posted on future events. — ${STUDIO_NAME}</p>
        </div>`;
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${rkey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: `${STUDIO_NAME} <${from}>`, to: [w.email], bcc: bcc ? [bcc] : undefined,
              subject: `A spot opened for ${title}!`, html: html + SIGNATURE_HTML }),
          });
          w.notified = new Date().toISOString();
          sent++;
        } catch {}
      }
      try { await store.setJSON(key, list); } catch {}
    }
    return json({ ok: true, waitlist: list, sent,
      message: rkey ? `Notified ${sent} ${sent === 1 ? "person" : "people"} on the waitlist.` : "Email isn't configured, so no notifications were sent." });
  }

  // ---------- Public join ----------
  const name = (b.name || "").toString().slice(0, 120).trim();
  const email = (b.email || "").toString().slice(0, 160).trim();
  const phone = (b.phone || "").toString().slice(0, 40).trim();
  const count = Math.max(1, Math.min(20, parseInt(b.count, 10) || 1));
  if (!name)                          return json({ error: "Please enter your name." }, 400);
  if (!/^\S+@\S+\.\S+$/.test(email))  return json({ error: "Please enter a valid email." }, 400);

  let list = [];
  try { list = (await store.get(key, { type: "json" })) || []; } catch { list = []; }
  if (list.some(x => (x.email || "").toLowerCase() === email.toLowerCase()))
    return json({ ok: true, message: "You're already on the waitlist — we'll email you if a space opens up!" });

  list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name, email, phone, count, at: new Date().toISOString(), notified: null });
  try { await store.setJSON(key, list); } catch { return json({ error: "Couldn't save. Try again." }, 502); }
  return json({ ok: true, message: "You're on the waitlist! We'll email you if a space opens up." });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/event-waitlist" };
