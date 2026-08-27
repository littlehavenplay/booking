// POST /api/reschedule   (admin key or staff PIN)
// Move an existing OPEN-PLAY booking or PARTY to a new date/time.
// Releases the original spot and books the new one (counts toward the new slot).
//   { key, action:"list", date }
//   { key, action:"move-booking", fromDate, fromSlot, entryId, toDate, toSlot, override?, notify? }
//   { key, action:"move-party", fromDate, fromSlot, toDate, toSlot, override?, notify? }
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML, fromHeader } from "./lib-email.js";
import { SLOT_IDS, SLOTS, ALL_SLOT_IDS, slotLabel, PARTY_SLOT_IDS, PARTY_SLOTS, openPlayForDate, hoursFor, slotCap, slotKey, isPartyDay, CLOSED_DATES, STUDIO_NAME, countHourChildren, hourMatesFor } from "./lib-settings.js";
import { getClosure, slotBlockedByClosure } from "./lib-closures.js";
import { loadSeasonal, loadWeekly } from "./lib-hours.js";
import { makeCredit, sendCreditEmail, ownerCopy } from "./lib-credit.js";

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
  const bookings = getStore("bookings");
  const parties = getStore("parties");

  // ---- LIST bookings + parties for a date ----
  if (action === "list") {
    const date = (b.date || "").toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a valid date." }, 400);
    const out = [];
    for (const slot of ALL_SLOT_IDS) {
      let rec = null; try { rec = await bookings.get(slotKey(date, slot), { type: "json" }); } catch {}
      if (!rec || !Array.isArray(rec.bookings)) continue;
      const label = slotLabel(slot);
      for (const e of rec.bookings) {
        if (e.type === "walkin" || e.type === "pass") continue;
        const giftPaid = Array.isArray(e.giftCards) ? e.giftCards.reduce((n, g) => n + (g.applied || 0), 0) : 0;
        const passes = Array.isArray(e.passesUsed) ? e.passesUsed.map(p => ({ code: p.code, admission: p.admission || "" })) : [];
        out.push({ kind: "booking", slot, slotLabel: label, id: e.id, name: e.name || "(no name)", email: e.email || "",
          children: (e.regular || 0) + (e.sibling || 0) + (e.infant || 0),
          cardPaid: e.cardPaid || 0, giftPaid, creditPaid: e.creditApplied || 0, amount: e.amount || 0, passes });
      }
    }
    const partyOut = [];
    for (const pid of PARTY_SLOT_IDS) {
      let rec = null; try { rec = await parties.get(slotKey(date, pid), { type: "json" }); } catch {}
      if (!rec) continue;
      const label = (PARTY_SLOTS.find(s => s.id === pid) || {}).label || pid;
      partyOut.push({ kind: "party", slot: pid, slotLabel: label, name: rec.name || rec.partyLabel || "Private party", email: rec.email || "",
        deposit: rec.deposit || 0, date, status: rec.status || "", packageLabel: rec.packageLabel || "" });
    }
    return json({ ok: true, date, bookings: out, parties: partyOut });
  }

  // ---- MOVE an open-play booking ----
  if (action === "move-booking") {
    const fromDate = (b.fromDate || "").toString(), fromSlot = (b.fromSlot || "").toString();
    const entryId = (b.entryId || "").toString();
    const toDate = (b.toDate || "").toString(), toSlot = (b.toSlot || "").toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return json({ error: "Pick a valid new date." }, 400);
    if (!SLOT_IDS.includes(toSlot)) return json({ error: "Pick a valid open-play session for the new time." }, 400);

    // Validate the new slot is actually open that day
    const v = await slotOpen(toDate, toSlot);
    if (!v.ok) return json({ error: v.reason }, 409);

    // Load the original booking
    const fromKey = slotKey(fromDate, fromSlot);
    let fromRec = null; try { fromRec = await bookings.get(fromKey, { type: "json", consistency: "strong" }); } catch {}
    if (!fromRec || !Array.isArray(fromRec.bookings)) return json({ error: "Original booking not found." }, 404);
    const idx = fromRec.bookings.findIndex(x => x.id === entryId && x.type !== "walkin" && x.type !== "pass");
    if (idx < 0) return json({ error: "That booking couldn't be found." }, 404);
    const entry = fromRec.bookings[idx];
    const childCount = (entry.regular || 0) + (entry.sibling || 0) + (entry.infant || 0);

    // Capacity check on the new slot (warn but allow override)
    const cap = slotCap(toSlot);
    const toKey = slotKey(toDate, toSlot);
    let toRec = null; try { toRec = await bookings.get(toKey, { type: "json", consistency: "strong" }); } catch {}
    if (!toRec || typeof toRec.children !== "number") toRec = { children: 0, bookings: [] };
    // The target arrival shares one pool of `cap` with its :00/:30 partner, so count
    // the whole hour. If we're only moving within the same hour, this booking is
    // already in that count — don't count it against itself.
    let hourNow = await countHourChildren(bookings, toDate, toSlot);
    if (toDate === fromDate && hourMatesFor(toSlot).includes(fromSlot)) hourNow = Math.max(0, hourNow - childCount);
    const wouldBe = hourNow + childCount;
    if (wouldBe > cap && !b.override) {
      return json({ ok: false, needConfirm: true, message: `That session would be at ${wouldBe}/${cap}. Move anyway?` });
    }

    // Remove from old slot
    fromRec.bookings.splice(idx, 1);
    fromRec.children = Math.max(0, (fromRec.children || 0) - childCount);
    try { await bookings.setJSON(fromKey, fromRec); } catch { return json({ error: "Couldn't update the original slot." }, 502); }

    // Add to new slot (preserve all payment/credit/pass fields)
    const moved = { ...entry, rescheduledFrom: { date: fromDate, slot: fromSlot, at: new Date().toISOString() } };
    toRec.bookings = Array.isArray(toRec.bookings) ? toRec.bookings : [];
    toRec.bookings.push(moved);
    toRec.children = (toRec.children || 0) + childCount;
    try { await bookings.setJSON(toKey, toRec); } catch { return json({ error: "Couldn't book the new slot." }, 502); }

    const toLabel = slotLabel(toSlot);
    const fromLabel = slotLabel(fromSlot);
    let emailed = false;
    if (b.notify && entry.email && /^\S+@\S+\.\S+$/.test(entry.email)) {
      emailed = await sendReschedule(entry.email, entry.name, fromDate, fromLabel, toDate, toLabel);
    }
    return json({ ok: true, message: `Moved ${entry.name || "booking"} to ${toDate} · ${toLabel} (now ${wouldBe}/${cap}).`, emailed });
  }

  // ---- MOVE a party ----
  if (action === "move-party") {
    const fromDate = (b.fromDate || "").toString(), fromSlot = (b.fromSlot || "").toString();
    const toDate = (b.toDate || "").toString(), toSlot = (b.toSlot || "").toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return json({ error: "Pick a valid new date." }, 400);
    if (!PARTY_SLOT_IDS.includes(toSlot)) return json({ error: "Pick a valid party time for the new slot." }, 400);
    if (!isPartyDay(toDate)) return json({ error: "Parties are available Friday, Saturday & Sunday only." }, 400);

    const fromKey = slotKey(fromDate, fromSlot), toKey = slotKey(toDate, toSlot);
    let rec = null; try { rec = await parties.get(fromKey, { type: "json" }); } catch {}
    if (!rec) return json({ error: "Original party not found." }, 404);
    let existing = null; try { existing = await parties.get(toKey, { type: "json" }); } catch {}
    if (existing && !b.override) return json({ ok: false, needConfirm: true, message: "That party time is already taken. Move anyway?" });

    const toLabel = (PARTY_SLOTS.find(s => s.id === toSlot) || {}).label || toSlot;
    const moved = { ...rec, partySlot: toSlot, partyLabel: toLabel, date: toDate, rescheduledFrom: { date: fromDate, slot: fromSlot, at: new Date().toISOString() } };
    try { await parties.setJSON(toKey, moved); } catch { return json({ error: "Couldn't book the new party time." }, 502); }
    try { await parties.delete(fromKey); } catch {}

    let emailed = false;
    if (b.notify && rec.email && /^\S+@\S+\.\S+$/.test(rec.email)) {
      const fromLabel = (PARTY_SLOTS.find(s => s.id === fromSlot) || {}).label || fromSlot;
      emailed = await sendReschedule(rec.email, rec.name, fromDate, fromLabel, toDate, toLabel, true);
    }
    return json({ ok: true, message: `Party moved to ${toDate} · ${toLabel}.`, emailed });
  }

  // ---- CANCEL an open-play booking + refund by payment type ----
  if (action === "cancel-booking") {
    const fromDate = (b.fromDate || "").toString(), fromSlot = (b.fromSlot || "").toString();
    const entryId = (b.entryId || "").toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !ALL_SLOT_IDS.includes(fromSlot)) return json({ error: "Bad booking reference." }, 400);
    const fromKey = slotKey(fromDate, fromSlot);
    let rec = null; try { rec = await bookings.get(fromKey, { type: "json", consistency: "strong" }); } catch {}
    if (!rec || !Array.isArray(rec.bookings)) return json({ error: "That date/slot has no bookings." }, 404);
    const idx = rec.bookings.findIndex(e => e.id === entryId);
    if (idx < 0) return json({ error: "Booking not found." }, 404);
    const entry = rec.bookings[idx];
    const childCount = (entry.regular || 0) + (entry.sibling || 0) + (entry.infant || 0);

    // Release the spot (frees capacity, reopens online)
    rec.bookings.splice(idx, 1);
    rec.children = Math.max(0, (rec.children || 0) - childCount);
    try { await bookings.setJSON(fromKey, rec); } catch { return json({ error: "Couldn't release the spot." }, 502); }

    const fromLabel = slotLabel(fromSlot);
    const reason = (b.reason || `Cancelled booking — ${entry.name || "guest"}, ${fromDate} ${fromLabel}`).toString().slice(0, 200);
    const okEmail = entry.email && /^\S+@\S+\.\S+$/.test(entry.email);
    const codes = [];

    // Return punch-card visits (no dollars)
    let punchesRestored = 0;
    if (b.restorePunches && Array.isArray(entry.passesUsed) && entry.passesUsed.length) {
      const passStore = getStore("passes");
      for (const p of entry.passesUsed) {
        try {
          const fresh = await passStore.get("pass:" + p.code, { type: "json" });
          if (fresh) {
            fresh.visitsRemaining = (fresh.visitsRemaining || 0) + 1;
            if (fresh.active === false) fresh.active = true;
            fresh.history = Array.isArray(fresh.history) ? fresh.history : [];
            fresh.history.push({ at: new Date().toISOString(), action: "visit-restored", where: "booking cancelled" });
            await passStore.setJSON("pass:" + p.code, fresh);
            punchesRestored++;
          }
        } catch {}
      }
    }

    // Courtesy credit (card + any store credit they had applied) — open-play only
    const courtesyCents = Math.round((parseFloat(b.courtesyAmount) || 0) * 100);
    if (courtesyCents > 0) {
      const c = await makeCredit("courtesy", courtesyCents, reason, { custName: entry.name, email: entry.email });
      if (c) { codes.push(c); if (b.notify && okEmail) await sendCreditEmail(entry.email, c, false); await ownerCopy(c); }
    }
    // Standard credit (gift-card portion) — usable anywhere
    const standardCents = Math.round((parseFloat(b.standardAmount) || 0) * 100);
    if (standardCents > 0) {
      const c = await makeCredit("standard", standardCents, reason, { custName: entry.name, email: entry.email });
      if (c) { codes.push(c); if (b.notify && okEmail) await sendCreditEmail(entry.email, c, false); await ownerCopy(c); }
    }

    let msg = `Cancelled ${entry.name || "booking"} (${fromDate} · ${fromLabel}). Spot released.`;
    if (punchesRestored) msg += ` ${punchesRestored} punch visit${punchesRestored === 1 ? "" : "s"} returned.`;
    for (const c of codes) msg += ` ${c.type === "courtesy" ? "Courtesy" : "Standard"} credit ${c.code} = $${(c.amount / 100).toFixed(2)}.`;
    return json({ ok: true, message: msg, codes: codes.map(c => ({ code: c.code, type: c.type, amount: c.amount })), punchesRestored, emailed: b.notify && okEmail && codes.length > 0 });
  }

  // ---- CANCEL a party (full $ refund handled in Square, or store credit) ----
  if (action === "cancel-party") {
    const fromDate = (b.fromDate || "").toString(), fromSlot = (b.fromSlot || "").toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !PARTY_SLOT_IDS.includes(fromSlot)) return json({ error: "Bad party reference." }, 400);
    const fromKey = slotKey(fromDate, fromSlot);
    let rec = null; try { rec = await parties.get(fromKey, { type: "json" }); } catch {}
    if (!rec) return json({ error: "Party not found." }, 404);
    const mode = (b.mode || "").toString(); // "dollars" | "credit" | "none"

    // Release the slot (reopens for open play / parties)
    try { await parties.delete(fromKey); } catch { return json({ error: "Couldn't release the party slot." }, 502); }

    const fromLabel = (PARTY_SLOTS.find(s => s.id === fromSlot) || {}).label || fromSlot;
    const reason = (b.reason || `Cancelled party — ${rec.name || "guest"}, ${fromDate} ${fromLabel}`).toString().slice(0, 200);
    const dep = rec.deposit || 0;

    if (mode === "credit") {
      const provided = parseFloat(b.creditAmount);
      const cents = provided > 0 ? Math.round(provided * 100) : dep;
      if (!(cents > 0)) return json({ error: "Enter a credit amount." }, 400);
      const c = await makeCredit("standard", cents, reason, { custName: rec.name, email: rec.email });
      if (!c) return json({ error: "Released the slot, but couldn't issue the credit. Try the Issue Credit tool." }, 502);
      if (b.notify && rec.email && /^\S+@\S+\.\S+$/.test(rec.email)) await sendCreditEmail(rec.email, c, false);
      await ownerCopy(c);
      return json({ ok: true, message: `Party cancelled and slot released. Standard credit ${c.code} = $${(c.amount / 100).toFixed(2)} issued.`, codes: [{ code: c.code, type: c.type, amount: c.amount }] });
    }
    return json({ ok: true, message: `Party cancelled and slot released.${mode === "dollars" ? ` Refund the $${(dep / 100).toFixed(2)} deposit to the customer in Square.` : ""}` });
  }

  return json({ error: "Unknown action." }, 400);
};

// Is an open-play slot actually open/bookable on a date?
async function slotOpen(date, slot) {
  if (CLOSED_DATES.includes(date)) return { ok: false, reason: "That date is marked closed." };
  const closure = await getClosure(date);
  if (slotBlockedByClosure(closure, slot)) return { ok: false, reason: "That session is closed on the new date." };
  const parties = getStore("parties");
  const bookedPartyIds = [];
  for (const pid of PARTY_SLOT_IDS) { try { if (await parties.get(slotKey(date, pid), { type: "json" })) bookedPartyIds.push(pid); } catch {} }
  const daySlots = openPlayForDate(date, bookedPartyIds, hoursFor(date, await loadSeasonal(), await loadWeekly()));
  if (!daySlots.some(s => s.id === slot)) return { ok: false, reason: "That session isn't offered on the new date." };
  const blocks = getStore("blocks");
  try { const blk = await blocks.get(slotKey(date, slot), { type: "json" }); if (blk && blk.reserved) return { ok: false, reason: "That session is reserved for a private party on the new date." }; } catch {}
  return { ok: true };
}

async function sendReschedule(to, name, fromDate, fromLabel, toDate, toLabel, isParty) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studio = STUDIO_NAME || "Little Haven Play Studio";
  if (!key) return false;
  const fmt = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const what = isParty ? "private party" : "open play visit";
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:540px;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal">Your booking has been rescheduled ✅</h2>
    <p>Hi ${esc(name) || "there"}, your ${what} at ${esc(studio)} has been moved as requested:</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px;margin:10px 0">
      <tr><td style="padding:6px 0;color:#8a8276;text-decoration:line-through">Previous</td><td style="padding:6px 0;text-align:right;color:#8a8276;text-decoration:line-through">${esc(fmt(fromDate))} · ${esc(fromLabel)}</td></tr>
      <tr><td style="padding:6px 0;color:#5c6470"><b>New date &amp; time</b></td><td style="padding:6px 0;text-align:right;font-weight:bold;color:#4d7848">${esc(fmt(toDate))} · ${esc(toLabel)}</td></tr>
    </table>
    <p>Your original date and time have been <b>cancelled</b>, and your spot on the new date is confirmed. No further action or payment is needed.</p>
    <p style="margin-top:12px">We look forward to seeing you! 💛</p>
    <p style="margin-top:14px;background:#fcfaf6;border:1px solid #efe7da;border-radius:10px;padding:11px 13px;font-size:13px;color:#5c6470"><b>📩 Don't see this clearly?</b> Please check your junk/spam folder.</p>
  </div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromHeader(from, studio), to: [to], bcc: process.env.STUDIO_EMAIL ? [process.env.STUDIO_EMAIL] : undefined, subject: `Your ${studio} booking has been rescheduled`, html: html + SIGNATURE_HTML }),
    });
    return res.ok;
  } catch { return false; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/reschedule" };
