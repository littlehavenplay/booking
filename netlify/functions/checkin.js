// POST /api/checkin  (admin key or staff PIN)
// In-store check-ins that count toward the SAME per-session 15 capacity as
// online bookings, and update the website's "X left" automatically.
//
// Body:
//   { key, action:"walkin", count }                  -> log N walk-in children
//   { key, action:"pass", code, count }              -> use N visits on a pass + count them
//   { key, action:"remove", date, slot, entryId }    -> undo a walk-in / pass check-in
//
// Walk-ins & pass check-ins are auto-assigned to the session whose START time is
// nearest the current Pacific time (e.g. 10:50 AM -> 11:00-1:00). Each is tagged
// with a timestamp so you can see exactly when each group arrived.
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import { ARRIVAL, openPlayForDate, slotCap, slotKey, PARTY_SLOT_IDS, hoursFor } from "./lib-settings.js";
import { loadSeasonal, loadWeekly } from "./lib-hours.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const action = (b.action || "").toString();
  const waiverConfirmed = b.waiverConfirmed === true;   // staff confirmed all adults+children on WaiverMaster
  const bookings = getStore("bookings");

  // ---- REMOVE (undo a walk-in or pass check-in) ----
  if (action === "remove") {
    const date = (b.date || "").toString();
    const slot = (b.slot || "").toString();
    const entryId = (b.entryId || "").toString();
    const key = slotKey(date, slot);
    let rec = null; try { rec = await bookings.get(key, { type: "json" }); } catch {}
    if (!rec || !Array.isArray(rec.bookings)) return json({ error: "Nothing to remove." }, 404);
    const idx = rec.bookings.findIndex(x => x.id === entryId && (x.type === "walkin" || x.type === "pass"));
    if (idx < 0) return json({ error: "That entry can't be removed here." }, 400);
    const entry = rec.bookings[idx];
    const n = entry.children || 0;
    rec.bookings.splice(idx, 1);
    rec.children = Math.max(0, (rec.children || 0) - n);
    try { await bookings.setJSON(key, rec); } catch { return json({ error: "Couldn't update. Try again." }, 502); }
    // If it was a pass check-in, give the visits back to the pass
    if (entry.type === "pass" && entry.code) {
      const passes = getStore("passes");
      let p = null; try { p = await passes.get("pass:" + entry.code, { type: "json" }); } catch {}
      if (p) { p.visitsRemaining = (p.visitsRemaining || 0) + n; try { await passes.setJSON("pass:" + entry.code, p); } catch {} }
    }
    return json({ ok: true, message: `Removed ${n} ${entry.type === "pass" ? "pass check-in" : "walk-in"} child${n === 1 ? "" : "ren"}.` });
  }

  // ---- Figure out the current session from Pacific time ----
  const date = pacificDate();
  const nowMin = pacificMinutes();
  const bookedPartyIds = await bookedParties(date);
  const seasonal = await loadSeasonal();
  const weekly = await loadWeekly();
  const daySlots = openPlayForDate(date, bookedPartyIds, hoursFor(date, seasonal, weekly));
  if (!daySlots.length) return json({ error: "There are no open-play sessions today." }, 400);
  // nearest arrival start; ties go to the earlier one
  let chosen = daySlots[0];
  let bestDiff = Infinity;
  for (const s of daySlots) {
    const start = ARRIVAL[s.id]?.start ?? 0;
    const diff = Math.abs(start - nowMin);
    if (diff < bestDiff) { bestDiff = diff; chosen = s; }
  }
  // Staff can override the auto-pick by passing an explicit arrival time block.
  const reqSlot = (b.slot || "").toString();
  if (reqSlot && daySlots.some(s => s.id === reqSlot)) chosen = daySlots.find(s => s.id === reqSlot);
  const slot = chosen.id;
  const key = slotKey(date, slot);
  const cap = slotCap(slot);
  const atISO = new Date().toISOString();
  const atLabel = pacificClock();

  // ---- PASS CHECK-IN ----
  if (action === "pass") {
    const code = (b.code || "").toString().trim().toUpperCase();
    const count = Math.max(1, parseInt(b.count, 10) || 1);
    const passes = getStore("passes");
    let p = null; try { p = await passes.get("pass:" + code, { type: "json" }); } catch {}
    if (!p)               return json({ error: "That pass code wasn't found." }, 404);
    if (!p.active)        return json({ error: "That pass is no longer active." }, 400);
    if ((p.visitsRemaining || 0) < count) return json({ error: `That pass only has ${p.visitsRemaining || 0} visit(s) left.` }, 400);
    if (p.expiry && p.expiry < date)      return json({ error: `That pass expired on ${p.expiry}.` }, 400);

    const wasRemaining = (p.visitsRemaining || 0);
    p.visitsRemaining = wasRemaining - count;
    p.usage = Array.isArray(p.usage) ? p.usage : [];
    p.usage.push({ at: atISO, count, where: "in-store", slot });

    // "Buy 7, 8th free": the visit that empties the card is the FREE one. When this
    // check-in brings the card to 0, celebrate + prompt staff to offer a reload,
    // and fire the empty-card reminder email (unless one was already sent this cycle).
    const freeVisit = p.visitsRemaining === 0;
    let reminderEmailed = false;
    if (freeVisit && !p.reminderSentAt) {
      try { await sendEmptyCardReminder(p); p.reminderSentAt = atISO; reminderEmailed = true; } catch {}
    }
    try { await passes.setJSON("pass:" + code, p); } catch { return json({ error: "Couldn't update the pass. Try again." }, 502); }

    const rec = await addToSession(bookings, key, {
      id: crypto.randomUUID(), type: "pass", code, childName: p.childName || "", children: count,
      label: p.label || "", at: atISO, atLabel, waiverConfirmed, waiverConfirmedAt: waiverConfirmed ? atISO : null,
    });
    return json({
      ok: true, slot, slotLabel: chosen.label, atLabel,
      visitsRemaining: p.visitsRemaining, code, label: p.label || "",
      freeVisit, reloadPrompt: freeVisit, reminderEmailed,
      celebration: freeVisit ? "🎉 This one's on us — free visit! Ask if they'd like to reload their card." : "",
      children: rec.children, cap, remaining: Math.max(0, cap - rec.children), over: rec.children > cap,
      message: freeVisit
        ? `🎉 Free visit! Pass ${code} is now used up — this last visit was on us. Offer a reload to keep the same code.`
        : `Checked in ${count} on pass ${code} to ${chosen.label}. ${p.visitsRemaining} visit(s) left.`,
    });
  }

  // ---- WALK-IN ----
  if (action === "walkin") {
    const count = Math.max(1, parseInt(b.count, 10) || 0);
    if (count < 1) return json({ error: "Enter how many children walked in." }, 400);
    const adultCount = Math.max(0, parseInt(b.adults, 10) || 0);
    const rec = await addToSession(bookings, key, {
      id: crypto.randomUUID(), type: "walkin", children: count, adults: adultCount, at: atISO, atLabel,
      waiverConfirmed, waiverConfirmedAt: waiverConfirmed ? atISO : null,
    });
    return json({
      ok: true, slot, slotLabel: chosen.label, atLabel,
      children: rec.children, cap, remaining: Math.max(0, cap - rec.children), over: rec.children > cap,
      message: `Logged ${count} walk-in child${count === 1 ? "" : "ren"}${adultCount ? ` + ${adultCount} adult${adultCount === 1 ? "" : "s"}` : ""} at ${atLabel} → ${chosen.label}.`,
    });
  }

  return json({ error: "Unknown action." }, 400);
};

async function addToSession(bookings, key, entry) {
  let rec = null; try { rec = await bookings.get(key, { type: "json" }); } catch {}
  if (!rec || typeof rec.children !== "number") rec = { children: 0, bookings: [] };
  rec.bookings = Array.isArray(rec.bookings) ? rec.bookings : [];
  rec.bookings.push(entry);
  rec.children = (rec.children || 0) + (entry.children || 0);
  try { await bookings.setJSON(key, rec); } catch {}
  return rec;
}

async function bookedParties(date) {
  const parties = getStore("parties");
  const ids = [];
  for (const pid of PARTY_SLOT_IDS) {
    try { if (await parties.get(slotKey(date, pid), { type: "json" })) ids.push(pid); } catch {}
  }
  return ids;
}

function pacificDate() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }
function pacificMinutes() {
  const hm = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false });
  const [h, m] = hm.split(":").map(n => parseInt(n, 10));
  return h * 60 + m;
}
function pacificClock() {
  return new Date().toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
}
// Email the card holder that their card is used up, with a one-tap reload link.
async function sendEmptyCardReminder(p) {
  const key = process.env.RESEND_API_KEY;
  const to = p && p.buyerEmail;
  if (!key || !to) return;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const studio = "Little Haven Play Studio";
  const code = p.code || "";
  const child = p.childName ? ` for ${p.childName}` : "";
  const reloadUrl = `https://littlehavenplay.com/pass.html?code=${encodeURIComponent(code)}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:0 auto;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">That last visit was on us 🎉</h2>
    <p style="margin:0 0 12px;color:#5c6470">Your punch card${child} is all used up — we hope you enjoyed your free 8th visit! Reload the <b>same code</b> anytime to keep playing; any visits left over always roll over.</p>
    <div style="background:#fcfaf6;border:1px solid #efe7da;border-radius:12px;padding:14px 16px;margin:10px 0">
      <div style="font-size:13px;color:#5c6470">Your card code</div>
      <div style="font-size:22px;font-weight:bold;color:#a85f59;letter-spacing:1px;margin:4px 0">${code}</div>
      <div style="margin-top:10px"><a href="${reloadUrl}" style="display:inline-block;background:#7ba06c;color:#fff;text-decoration:none;font-weight:bold;font-size:13px;padding:9px 16px;border-radius:10px">Reload my card →</a></div>
    </div>
    <p style="margin:12px 0 0;font-size:13px;color:#5f7d52">☕ Punch card holders get free coffee every visit, plus 2 adults included.</p>
    <p style="margin:14px 0 0;font-size:13px;color:#5c6470">See you soon! — ${studio}</p></div>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `${studio} <${from}>`, to: [to], bcc: bcc ? [bcc] : undefined,
      subject: `Your punch card is used up — reload the same code`, html: html + SIGNATURE_HTML }),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/checkin" };
