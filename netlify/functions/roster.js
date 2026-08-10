// GET /api/roster?key=ADMIN_KEY&date=YYYY-MM-DD   (protected by ADMIN_KEY)
// Returns everyone booked for each session on a date, so you can check names
// against signed waivers and the adult bringing them in.

import { getStore } from "@netlify/blobs";
import { SLOTS, slotKey, ARRIVAL_TO_LEGACY, hourMatesFor, arrivalStartMin, ARRIVAL, slotLabel, ARRIVAL_CAP } from "./lib-settings.js";

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  const date = (url.searchParams.get("date") || "").trim();

  const adminKey = process.env.ADMIN_KEY || "";
  if (!adminKey)            return json({ error: "Admin key isn't configured. Set ADMIN_KEY in Netlify." }, 500);
  if (key !== adminKey)     return json({ error: "Wrong admin key." }, 401);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a valid date." }, 400);

  const bookings = getStore("bookings");
  const blocks = getStore("blocks");

  const sessions = [];
  let dayTotalChildren = 0, dayTotalGuests = 0;

  const seenHours = new Set();
  for (const slot of SLOTS) {
    // Fold each clock hour's :00 and :30 into ONE session (they share a cap of 6).
    // The :00 ids come first in SLOTS, so the first id we see for an hour is its anchor.
    const startMin = arrivalStartMin(slot.id);
    const hourId = startMin == null ? slot.id : ("h" + Math.floor(startMin / 60));
    if (seenHours.has(hourId)) continue;
    seenHours.add(hourId);

    const mateIds = hourMatesFor(slot.id);   // [:00, :30, and any legacy id for this hour]
    let reserved = false;
    for (const mid of mateIds) { try { if (await blocks.get(slotKey(date, mid), { type: "json" })) { reserved = true; break; } } catch {} }

    const people = [], checkins = [];
    let sChildren = 0, sAdults = 0;
    for (const mid of mateIds) {
      let rec = null;
      try { rec = await bookings.get(slotKey(date, mid), { type: "json" }); } catch { rec = null; }
      if (!rec || !Array.isArray(rec.bookings)) continue;
      const legacy = !ARRIVAL[mid];
      const arrivalLabel = ARRIVAL[mid] ? ARRIVAL[mid].label : slotLabel(mid);   // "1:00 PM" vs "1:30 PM"
      for (const b of rec.bookings) {
        if (b.type === "walkin" || b.type === "pass") {
          const c = b.children || 0, a = b.type === "walkin" ? (b.adults || 0) : 1;
          sChildren += c; sAdults += a; dayTotalChildren += c; dayTotalGuests += c + a;
          checkins.push({ id: b.id, type: b.type, slot: mid, arrivalLabel, children: c, adults: a, code: b.code || null, childName: b.childName || "", atLabel: b.atLabel || "", at: b.at || null, legacy });
        } else {
          const children = (b.regular || 0) + (b.sibling || 0) + (b.infant || 0);
          const adults = typeof b.adultsTotal === "number"
            ? b.adultsTotal
            : 1 + (b.adults || 0);
          sChildren += children; sAdults += adults; dayTotalChildren += children; dayTotalGuests += children + adults;
          let paid = [];
          if (b.cardPaid) paid.push("card " + money(b.cardPaid));
          if (b.giftCards && b.giftCards.length) paid.push("gift card");
          if (b.creditApplied) paid.push("store credit");
          if (b.passesUsed && b.passesUsed.length) paid.push(b.passesUsed.map(p => "pass " + p.code).join(", "));
          people.push({ id: b.id || null, name: b.name || "(no name)", email: b.email || "", slot: mid, legacy, arrivalLabel,
            regular: b.regular || 0, sibling: b.sibling || 0, infant: b.infant || 0, adults, children,
            paid: paid.join(" + ") || "—", at: b.at || null });
        }
      }
    }
    if (!people.length && !checkins.length && !reserved) continue;   // skip empty sessions

    sessions.push({
      slot: slot.id,
      label: slot.label,
      reserved,
      cap: ARRIVAL_CAP,
      children: sChildren,
      adultsTotal: sAdults,
      peopleTotal: sChildren + sAdults,
      count: people.length,
      people,
      checkins,
    });
  }

  let arrivals={}; try{ arrivals=(await getStore("arrivals").get(date,{type:"json"}))||{}; }catch{}
  return json({ date, sessions, dayTotalChildren, dayTotalGuests , arrivals });
};

function money(c) { return "$" + (c / 100).toFixed(2); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/roster" };
