// POST /api/closures  (admin key or staff PIN)
// Manage day closures and early-close / late-open hours — no Netlify variables needed.
//   { key, action:"set", date, type:"full"|"early"|"late", cutoff?, note?, alsoBanner?, bannerHeadline?, bannerBody? }
//   { key, action:"clear", date }
//   { key, action:"list" }
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import { minutesToLabel, slotBlockedByClosure } from "./lib-closures.js";
import { ALL_SLOT_IDS, slotKey, STUDIO_NAME } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const site = getStore("site");
  const action = (b.action || "").toString();
  let closures = {};
  try { closures = (await site.get("closures", { type: "json" })) || {}; } catch { closures = {}; }

  // PUBLIC read for the website (no key) — upcoming all-day closures only.
  if (action === "public") {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const items = Object.entries(closures)
      .filter(([d, c]) => d >= today && c && c.type === "full")
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, c]) => ({
        date,
        label: new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
        note: c.note || "",
      }));
    return json({ ok: true, closures: items });
  }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  if (action === "list") {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const items = Object.entries(closures)
      .filter(([d]) => d >= today)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, c]) => ({ date, type: c.type, cutoff: c.cutoff || null, cutoffLabel: c.cutoff ? minutesToLabel(c.cutoff) : null, note: c.note || "" }));
    return json({ ok: true, closures: items });
  }

  if (action === "set") {
    const date = (b.date || "").toString();
    const type = (b.type || "").toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a valid date." }, 400);
    if (!["full", "early", "late"].includes(type)) return json({ error: "Choose closed all day, early close, or late open." }, 400);
    let cutoff = null;
    if (type !== "full") {
      cutoff = parseInt(b.cutoff, 10);
      if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 1439) return json({ error: "Pick a valid time." }, 400);
    }
    const dLabel = new Date(date + "T12:00:00").toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
    const note = (b.note || "").toString().slice(0, 200).trim()
      || (type === "full" ? `Closed ${dLabel}.` : type === "early" ? `Last admission on ${dLabel} is ${minutesToLabel(cutoff)}.` : `Opening ${dLabel} at ${minutesToLabel(cutoff)}.`);
    closures[date] = { type, ...(cutoff != null ? { cutoff } : {}), note };
    try { await site.setJSON("closures", closures); } catch { return json({ error: "Couldn't save. Try again." }, 502); }

    // Optional: post the matching homepage banner at the same time.
    if (b.alsoBanner) {
      const headline = (b.bannerHeadline || "").toString().slice(0, 120).trim() || noteHeadline(date, type, cutoff);
      const body = (b.bannerBody || "").toString().slice(0, 1000).trim() || note;
      try { await site.setJSON("news", { headline, body, showUntil: date, at: new Date().toISOString() }); } catch {}
    }

    // Find existing open-play bookings affected by this closure.
    const closure = closures[date];
    const affected = await affectedBookings(date, closure);

    // Optional: email those customers an apology + full-refund notice now.
    let emailed = 0;
    if (b.notifyBookings && affected.length) {
      for (const a of affected) {
        if (a.email && /^\S+@\S+\.\S+$/.test(a.email)) {
          const ok = await sendClosureEmail(a, date, closure);
          if (ok) emailed++;
        }
      }
    }
    return json({ ok: true, message: "Saved.", date, note, affected, affectedCount: affected.length, emailed });
  }

  if (action === "notify") {
    const date = (b.date || "").toString();
    const closure = closures[date];
    if (!closure) return json({ error: "No closure is set for that date." }, 400);
    const affected = await affectedBookings(date, closure);
    let emailed = 0;
    for (const a of affected) {
      if (a.email && /^\S+@\S+\.\S+$/.test(a.email)) {
        const ok = await sendClosureEmail(a, date, closure);
        if (ok) emailed++;
      }
    }
    return json({ ok: true, message: `Emailed ${emailed} customer${emailed === 1 ? "" : "s"}.`, affected, affectedCount: affected.length, emailed });
  }

  if (action === "clear") {
    const date = (b.date || "").toString();
    if (closures[date]) { delete closures[date]; try { await site.setJSON("closures", closures); } catch { return json({ error: "Couldn't update. Try again." }, 502); } }
    return json({ ok: true, message: "Removed." });
  }

  return json({ error: "Unknown action." }, 400);
};

function noteHeadline(date, type, cutoff) {
  const d = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  if (type === "full") return `Closed ${d}`;
  if (type === "early") return `Last admission ${minutesToLabel(cutoff)} on ${d}`;
  return `Opening late ${d}`;
}

// Collect online bookings on a date that fall in a slot blocked by the closure.
async function affectedBookings(date, closure) {
  const bookings = getStore("bookings");
  const out = [];
  for (const slot of ALL_SLOT_IDS) {
    if (!slotBlockedByClosure(closure, slot)) continue;
    let rec = null;
    try { rec = await bookings.get(slotKey(date, slot), { type: "json" }); } catch { rec = null; }
    if (!rec || !Array.isArray(rec.bookings)) continue;
    for (const e of rec.bookings) {
      if (e.type === "walkin" || e.type === "pass") continue;   // in-store, not online
      out.push({
        name: e.name || "", email: e.email || "", slot,
        amount: e.amount || 0, cardPaid: e.cardPaid || 0, paymentId: e.paymentId || null,
      });
    }
  }
  return out;
}

async function sendClosureEmail(a, date, closure) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  if (!key) return false;
  const studio = STUDIO_NAME || "Little Haven Play Studio";
  const d = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const reason = closure.type === "full"
    ? `we will be closed on ${d}`
    : closure.type === "early"
      ? `our hours on ${d} have changed and your reserved session is no longer available`
      : `our opening time on ${d} has changed and your reserved session is no longer available`;
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal">An update about your reservation</h2>
    <p>Dear ${esc(a.name) || "Guest"},</p>
    <p>Please accept our sincere apologies — due to an unexpected change, ${reason}. We're very sorry for any inconvenience this may cause.</p>
    <p><b>You don't need to do anything.</b> A <b>full refund</b> for your booking will be issued to your original payment method, and you should see it credited to your account within the next few business days.</p>
    <p>We truly value your understanding and hope to welcome your family back to ${esc(studio)} very soon. If you have any questions, simply reply to this email or call us.</p>
    <p style="margin-top:16px">Warm regards,<br>The ${esc(studio)} Team</p>
    <p style="margin-top:14px;background:#fcfaf6;border:1px solid #efe7da;border-radius:10px;padding:11px 13px;font-size:13px;color:#5c6470"><b>📩 Don't see this email clearly?</b> Please check your junk/spam folder so you don't miss our updates.</p>
  </div>`;
  const text = `Dear ${a.name || "Guest"},\n\nPlease accept our sincere apologies — ${reason}. You don't need to do anything; a full refund will be issued to your original payment method and credited within the next few business days.\n\nWe're sorry for the inconvenience and hope to see you again soon at ${studio}.\n\n— The ${studio} Team`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${studio} <${from}>`, to: [a.email], bcc: process.env.STUDIO_EMAIL ? [process.env.STUDIO_EMAIL] : undefined, subject: `Important: a change to your ${studio} reservation`, html, text }),
    });
    return res.ok;
  } catch { return false; }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/closures" };
