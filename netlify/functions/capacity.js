import { getStore } from "@netlify/blobs";
import { CAPACITY, openPlayForDate, effectivePartyBlocks, slotCap, slotKey, arrivalStartMin, PARTY_SLOT_IDS, CLOSED_DATES, CLOSED_MESSAGE, ARRIVAL_TO_LEGACY, hoursFor, fmtClock, isClosedWeekday } from "./lib-settings.js";
import { loadSeasonal, loadWeekly } from "./lib-hours.js";
import { getClosure, applyClosure } from "./lib-closures.js";

export default async (req) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date");

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: "A valid ?date=YYYY-MM-DD is required." }, 400);
  }

  // Full-day closure from Netlify variable (legacy) or the admin/staff tool.
  if (CLOSED_DATES.includes(date)) {
    return json({ date, capacity: CAPACITY, slots: [], availability: {}, closed: true, closedMessage: CLOSED_MESSAGE });
  }

  // Recurring weekly closure (closed every Wednesday — unless a seasonal window reopens it).
  const seasonal = await loadSeasonal();
  const weekly = await loadWeekly();
  if (isClosedWeekday(date, seasonal, weekly)) {
    return json({ date, capacity: CAPACITY, slots: [], availability: {}, closed: true, closedMessage: "We're closed that day. Please choose another day — we'd love to see you!" });
  }

  const store = getStore("bookings");
  const blocks = getStore("blocks");

  // Which party slots are booked that day (confirmed or pending) — they take precedence.
  const bookedPartyIds = await bookedParties(date);
  const _hrs = hoursFor(date, seasonal, weekly);
  const allSlots = openPlayForDate(date, [], _hrs);
  const openAfterBooked = new Set(openPlayForDate(date, bookedPartyIds, _hrs).map(s => s.id));
  const openAfterPriority = new Set(openPlayForDate(date, effectivePartyBlocks(date, bookedPartyIds), _hrs).map(s => s.id));
  // Show open-play slots + booked-party windows (marked "private party"); hide only the
  // auto-priority windows that aren't actually booked yet.
  let daySlots = allSlots.filter(s => openAfterPriority.has(s.id) || !openAfterBooked.has(s.id));

  // Apply any closure / early-close / late-open set from the admin/staff page.
  const closure = await getClosure(date);
  const applied = applyClosure(closure, daySlots);
  daySlots = applied.slots;
  if (applied.closedAllDay) {
    return json({ date, capacity: CAPACITY, slots: [], availability: {}, closed: true, closedMessage: applied.message || "Closed this day." });
  }
  const notice = (closure && applied.partial) ? (closure.note || "") : "";

  const result = {};
  const _todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const _nowMinPT = (() => { const t = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour12: false }); const [h, m] = t.split(":").map(Number); return h * 60 + m; })();
  for (const slot of daySlots) {
    let rec = null, blockRec = null;
    try { rec = await store.get(slotKey(date, slot.id), { type: "json" }); } catch { rec = null; }
    try { blockRec = await blocks.get(slotKey(date, slot.id), { type: "json" }); } catch { blockRec = null; }
    let cap = slotCap(slot.id);
    let hardBlocked = false, limited = false;
    if (blockRec) {
      if (typeof blockRec.cap === "number") { cap = Math.min(cap, Math.max(0, blockRec.cap)); limited = true; }
      else hardBlocked = true;   // full block / manual reservation
    }
    let children = rec && typeof rec.children === "number" ? rec.children : 0;
    // Add any existing OLD-session bookings that map onto this arrival time.
    for (const legacy of (ARRIVAL_TO_LEGACY[slot.id] || [])) {
      try { const lr = await store.get(slotKey(date, legacy), { type: "json" }); if (lr && typeof lr.children === "number") children += lr.children; } catch {}
    }
    const _start = arrivalStartMin(slot.id);
    const past = (date === _todayPT && _start != null && _start <= _nowMinPT);
    const partyReserved = !openAfterBooked.has(slot.id);
    result[slot.id] = past
      ? { children, remaining: 0, full: true, reserved: true, reservedReason: "past", past: true }
      : (hardBlocked || partyReserved)
        ? { children, remaining: 0, full: true, reserved: true, reservedReason: partyReserved ? "private party" : "blocked" }
        : { children, remaining: Math.max(0, cap - children), full: children >= cap, cap, limited };
  }

  const _h = hoursFor(date, seasonal, weekly);
  const hoursLabel = `🕒 Open ${fmtClock(_h.open)}–${fmtClock(_h.close)} this day · last admission ${fmtClock(_h.close - 60)}` + (_h.seasonal ? ` (${_h.label})` : "");
  return json({ date, capacity: CAPACITY, slots: daySlots, availability: result, notice, hoursLabel });
};

async function bookedParties(date) {
  const parties = getStore("parties");
  const ids = [];
  for (const pid of PARTY_SLOT_IDS) {
    try { if (await parties.get(slotKey(date, pid), { type: "json" })) ids.push(pid); } catch {}
  }
  return ids;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/capacity" };
