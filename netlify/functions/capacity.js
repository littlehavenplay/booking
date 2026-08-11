import { getStore } from "@netlify/blobs";
import { CAPACITY, openPlayForDate, effectivePartyBlocks, slotCap, slotKey, arrivalStartMin, PARTY_SLOT_IDS, CLOSED_DATES, CLOSED_MESSAGE, ARRIVAL_TO_LEGACY, hoursFor, fmtClock, isClosedWeekday, countHourChildren, hourMatesFor } from "./lib-settings.js";
import { loadSeasonal, loadWeekly } from "./lib-hours.js";
import { getClosure, applyClosure, getEventHold } from "./lib-closures.js";

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

  // Automatic event hold: on event days, open-play last admission is 2.5h before the
  // earliest event that day. Late slots are hidden and a banner points to the events tab.
  const eventHold = await getEventHold(date);
  let specialEvent = null;
  if (eventHold) {
    daySlots = daySlots.filter(s => { const st = arrivalStartMin(s.id); return st == null || st <= eventHold.cutoff; });
    specialEvent = { lastAdmitLabel: eventHold.lastAdmitLabel,
      message: `Special event day! Last admission will be at ${eventHold.lastAdmitLabel}. To view our event click on the Events/Promotions tab for more info.` };
    if (daySlots.length === 0) {
      return json({ date, capacity: CAPACITY, slots: [], availability: {}, closed: true, closedMessage: specialEvent.message });
    }
  }

  const result = {};
  const _todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const _nowMinPT = (() => { const t = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour12: false }); const [h, m] = t.split(":").map(Number); return h * 60 + m; })();
  for (const slot of daySlots) {
    // A reservation/limit on either the :00 or the :30 covers the shared hour.
    let blockRec = null;
    for (const mid of hourMatesFor(slot.id)) {
      try { const br = await blocks.get(slotKey(date, mid), { type: "json" }); if (br) { blockRec = br; break; } } catch {}
    }
    let cap = slotCap(slot.id);
    let hardBlocked = false, limited = false;
    if (blockRec) {
      if (typeof blockRec.cap === "number") { cap = Math.min(cap, Math.max(0, blockRec.cap)); limited = true; }
      else hardBlocked = true;   // full block / manual reservation
    }
    // Children booked into this slot's shared hourly pool (its :00, :30, and any
    // legacy session for the same hour) — so 1:00 and 1:30 report the SAME remaining.
    let children = await countHourChildren(store, date, slot.id);
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
  const _lastAdmit = eventHold ? Math.min(_h.close - 60, eventHold.cutoff) : (_h.close - 60);
  const hoursLabel = `🕒 Open ${fmtClock(_h.open)}–${fmtClock(_h.close)} this day · last admission ${fmtClock(_lastAdmit)}` + (_h.seasonal ? ` (${_h.label})` : "");
  return json({ date, capacity: CAPACITY, slots: daySlots, availability: result, notice, hoursLabel, specialEvent });
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
