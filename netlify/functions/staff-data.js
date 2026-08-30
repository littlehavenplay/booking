// GET /api/staff-data?pin=STAFF_PIN&date=YYYY-MM-DD
// Returns the open-play roster (party-aware sessions) + party reservations for a date.

import { getStore } from "@netlify/blobs";
import { OPENPLAY, openPlayForDate, slotCap, slotKey, PARTY_SLOTS, PARTY_SLOT_IDS, ARRIVAL_TO_LEGACY, hoursFor, hourMatesFor, arrivalStartMin, ARRIVAL, slotLabel } from "./lib-settings.js";
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
  const seenHours = new Set();
  const seasonal = await loadSeasonal();
  const weekly = await loadWeekly();
  for (const slot of openPlayForDate(date, bookedPartyIds, hoursFor(date, seasonal, weekly))) {
    // Fold each hour's :00 and :30 into ONE session that shares a single cap of 6.
    // Slots arrive chronologically, so the first one we see for an hour is its anchor.
    const startMin = arrivalStartMin(slot.id);
    const hourId = startMin == null ? slot.id : ("h" + Math.floor(startMin / 60));
    if (seenHours.has(hourId)) continue;
    seenHours.add(hourId);

    const mateIds = hourMatesFor(slot.id);   // [:00, :30, and any legacy id for this hour]
    let reserved = false;
    for (const mid of mateIds) { try { if (await blocks.get(slotKey(date, mid), { type: "json" })) { reserved = true; break; } } catch {} }

    const people = [], checkins = [];
    let childrenTotal = 0, adultsTotal = 0;
    for (const mid of mateIds) {
      let rec = null;
      try { rec = await bookings.get(slotKey(date, mid), { type: "json" }); } catch { rec = null; }
      if (!rec || !Array.isArray(rec.bookings)) continue;
      childrenTotal += (typeof rec.children === "number" ? rec.children : 0);
      const legacy = !ARRIVAL[mid];
      const arrivalLabel = ARRIVAL[mid] ? ARRIVAL[mid].label : slotLabel(mid);   // "1:00 PM" vs "1:30 PM"
      for (const x of rec.bookings) {
        if (x.type === "walkin" || x.type === "pass") {
          adultsTotal += x.type === "walkin" ? (x.adults || 0) : 1;   // walk-in: entered; pass: 1 included
          checkins.push({ id: x.id, type: x.type, slot: mid, arrivalLabel, children: x.children || 0, adults: x.type === "walkin" ? (x.adults || 0) : 1,
            code: x.code || null, childName: x.childName || "", atLabel: x.atLabel || "", at: x.at || null, legacy });
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
          if (x.playClubCode) payParts.push("Play Club " + x.playClubCode);
          const paid = payParts.join(" + ") || "free / no charge";
          people.push({ id: x.id || null, name: x.name || "(no name)", email: x.email || "", slot: mid, legacy, arrivalLabel,
            childNames: Array.isArray(x.childNames) ? x.childNames : [], phone: x.phone || "",
            regular: x.regular || 0, sibling: x.sibling || 0, infant: x.infant || 0, adults,
            at: x.at || null, cardLast4: x.cardLast4 || null, paid,
            playClub: x.playClubCode || null, playClubName: x.playClubName || null,
            gripSocks: x.gripSocks || 0 });
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
