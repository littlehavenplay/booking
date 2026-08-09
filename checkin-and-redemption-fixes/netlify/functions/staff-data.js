// GET /api/staff-data?pin=STAFF_PIN&date=YYYY-MM-DD
// Returns the open-play roster (party-aware sessions) + party reservations for a date.

import { getStore } from "@netlify/blobs";
import { OPENPLAY, openPlayForDate, slotCap, slotKey, PARTY_SLOTS, PARTY_SLOT_IDS, ARRIVAL_TO_LEGACY, hoursFor } from "./lib-settings.js";
import { loadSeasonal, loadWeekly } from "./lib-hours.js";

export default async (req) => {
  const url = new URL(req.url);
  const pin = url.searchParams.get("pin") || "";
  const date = (url.searchParams.get("date") || "").trim();

  if (!staffOk(pin)) return json({ error: "Wrong staff PIN." }, 401);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a valid date." }, 400);

  const bookings = getStore("bookings");
  const blocks = getStore("blocks");
  const partiesStore = getStore("parties");

  // Parties booked that day
  const parties = [];
  const bookedPartyIds = [];
  for (const s of PARTY_SLOTS) {
    let rec = null;
    try { rec = await partiesStore.get(slotKey(date, s.id), { type: "json" }); } catch { rec = null; }
    if (rec) { parties.push(rec); bookedPartyIds.push(s.id); }
  }

  // Open play arrival times available that day (given parties), with rosters.
  // Each arrival slot also absorbs any existing OLD-session bookings that map to it.
  const sessions = [];
  const seasonal = await loadSeasonal();
  const weekly = await loadWeekly();
  for (const slot of openPlayForDate(date, bookedPartyIds, hoursFor(date, seasonal, weekly))) {
    let reserved = false;
    try { reserved = !!(await blocks.get(slotKey(date, slot.id), { type: "json" })); } catch { reserved = false; }
    // Gather this arrival slot's own record + any legacy session records mapped to it.
    const recKeys = [{ id: slot.id, legacy: false }, ...((ARRIVAL_TO_LEGACY[slot.id] || []).map(l => ({ id: l, legacy: true })))];
    const people = [], checkins = [];
    let childrenTotal = 0, adultsTotal = 0;
    for (const rk of recKeys) {
      let rec = null;
      try { rec = await bookings.get(slotKey(date, rk.id), { type: "json" }); } catch { rec = null; }
      if (!rec || !Array.isArray(rec.bookings)) continue;
      childrenTotal += (typeof rec.children === "number" ? rec.children : 0);
      for (const x of rec.bookings) {
        if (x.type === "walkin" || x.type === "pass") {
          adultsTotal += x.type === "walkin" ? (x.adults || 0) : 1;   // walk-in: entered; pass: 1 included
          checkins.push({ id: x.id, type: x.type, slot: rk.id, children: x.children || 0, adults: x.type === "walkin" ? (x.adults || 0) : 1,
            code: x.code || null, childName: x.childName || "", atLabel: x.atLabel || "", at: x.at || null, legacy: rk.legacy });
        } else {
          const adults = typeof x.adultsTotal === "number"
            ? x.adultsTotal
            : 1 + (x.adults || 0);                         // legacy bookings stored paid extras only
          adultsTotal += adults;
          // Payment record (for matching to Square): when it was booked/paid, the
          // card's last 4, and how it was paid.
          const payParts = [];
          if (x.cardPaid) payParts.push("card" + (x.cardLast4 ? " ••••" + x.cardLast4 : ""));
          if (x.giftCards && x.giftCards.length) payParts.push("gift card");
          if (x.creditApplied) payParts.push("store credit");
          if (x.passesUsed && x.passesUsed.length) payParts.push("prepaid pass");
          const paid = payParts.join(" + ") || "free / no charge";
          people.push({ id: x.id || null, name: x.name || "(no name)", email: x.email || "", slot: rk.id, legacy: rk.legacy,
            childNames: Array.isArray(x.childNames) ? x.childNames : [], phone: x.phone || "",
            regular: x.regular || 0, sibling: x.sibling || 0, infant: x.infant || 0, adults,
            at: x.at || null, cardLast4: x.cardLast4 || null, paid });
        }
      }
    }
    sessions.push({
      slot: slot.id, label: slot.label, reserved,
      cap: slotCap(slot.id),
      children: childrenTotal,
      adultsTotal, peopleTotal: childrenTotal + adultsTotal,
      people, checkins,
    });
  }

  let arrivals = {};
  try { arrivals = (await getStore("arrivals").get(date, { type: "json" })) || {}; } catch {}

  return json({ date, sessions, parties, arrivals });
};

function staffOk(pin) {
  return (!!process.env.STAFF_PIN && pin === process.env.STAFF_PIN) ||
         (!!process.env.ADMIN_KEY && pin === process.env.ADMIN_KEY);
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/staff-data" };
