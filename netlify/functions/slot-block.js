// POST /api/slot-block   (protected by ADMIN_KEY)
// Body: { key, date, slot, action: "reserve" | "release" | "cap", note }
//   or: { key, date, fromTime: "14:30", toTime: "16:30",
//         action: "blockRange" | "releaseRange", note }
//
// blockRange closes every open-play arrival time inside the window, so
// "nobody books 2:30-4:30" is one action instead of hunting slot by slot.
// Reserves (or releases) a specific date + time slot for a private party so it
// is no longer bookable for open play. Use once a party deposit is paid.

import { getStore } from "@netlify/blobs";
import { SLOT_IDS, PARTY_SLOT_IDS, PARTY_SLOTS, ARRIVAL, slotLabel, isPartyDay, slotKey } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured. Set ADMIN_KEY in Netlify." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const date = (b.date || "").trim();
  const slot = (b.slot || "").trim();
  const rangeAction = (b.action === "blockRange" || b.action === "releaseRange");
  const action = (b.action || "reserve").trim();
  const note = (b.note || "").toString().slice(0, 200).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a valid date." }, 400);

  // ---- Block or reopen a whole window of open-play arrivals in one go ----
  if (rangeAction) {
    const fromMin = hhmmToMinutes(b.fromTime);
    const toMin = hhmmToMinutes(b.toTime);
    if (fromMin == null || toMin == null) return json({ error: "Pick a start and an end time." }, 400);
    if (toMin <= fromMin) return json({ error: "The end time has to be after the start time." }, 400);

    // Arrival times are start times, so an arrival is inside the window when its
    // start falls at or after the beginning and strictly before the end.
    const hit = SLOT_IDS.filter((id) => {
      const s = ARRIVAL[id] && ARRIVAL[id].start;
      return typeof s === "number" && s >= fromMin && s < toMin;
    });
    if (!hit.length) return json({ error: "No open-play arrival times fall inside that window." }, 400);

    const blocks = getStore("blocks");
    const done = [];
    for (const id of hit) {
      const k = slotKey(date, id);
      try {
        if (b.action === "releaseRange") await blocks.delete(k);
        else await blocks.setJSON(k, { reserved: true, note, at: new Date().toISOString() });
        done.push(slotLabel(id));
      } catch {}
    }
    if (!done.length) return json({ error: "Couldn't save. Try again." }, 502);
    const win = `${minutesToLabel(fromMin)}\u2013${minutesToLabel(toMin)}`;
    return json({
      ok: true, date, slots: hit, count: done.length,
      action: b.action === "releaseRange" ? "range-released" : "range-blocked",
      message: b.action === "releaseRange"
        ? `Reopened ${done.length} arrival time${done.length === 1 ? "" : "s"} (${win}) on ${date}.`
        : `Blocked ${done.length} arrival time${done.length === 1 ? "" : "s"} (${win}) on ${date}: ${done.join(", ")}. Open play can't be booked in that window.`,
    });
  }

  const isParty = PARTY_SLOT_IDS.includes(slot);
  if (!isParty && !SLOT_IDS.includes(slot)) return json({ error: "Pick a valid time slot." }, 400);

  // ---- Party time slots (incl. 5–7 PM): reserve via the parties store ----
  if (isParty) {
    if (!isPartyDay(date)) return json({ error: "Party slots are available Friday, Saturday & Sunday only." }, 400);
    const parties = getStore("parties");
    const k = slotKey(date, slot);
    const label = (PARTY_SLOTS.find(s => s.id === slot) || {}).label || slot;
    if (action === "release") {
      try { await parties.delete(k); } catch {}
      return json({ ok: true, action: "released", date, slot, message: `${label} party slot released.` });
    }
    try { await parties.setJSON(k, { status: "confirmed-instore", reservedManually: true, partySlot: slot, partyLabel: label, date, note, at: new Date().toISOString() }); }
    catch { return json({ error: "Couldn't save the reservation. Try again." }, 502); }
    return json({ ok: true, action: "reserved", date, slot, message: `${label} reserved for a private party. It's now blocked from new bookings.` });
  }

  // ---- Open-play slots: reserve via the blocks store (legacy behavior) ----
  const blocks = getStore("blocks");
  const k = slotKey(date, slot);

  if (action === "release") {
    try { await blocks.delete(k); } catch {}
    return json({ ok: true, action: "released", date, slot, message: "Slot released — back to normal open-play capacity." });
  }

  // Limit this session to a custom number of children (capacity control).
  if (action === "cap") {
    const cap = parseInt(b.cap, 10);
    if (!Number.isFinite(cap) || cap < 0 || cap > 200) return json({ error: "Enter a capacity between 0 and 200." }, 400);
    try { await blocks.setJSON(k, { cap, note, at: new Date().toISOString() }); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, action: "capped", date, slot, cap,
      message: cap === 0 ? "This session now accepts 0 children (effectively closed)." : `This session is now limited to ${cap} child${cap === 1 ? "" : "ren"}. The website shows the reduced spots.` });
  }

  try { await blocks.setJSON(k, { reserved: true, note, at: new Date().toISOString() }); }
  catch { return json({ error: "Couldn't save the reservation. Try again." }, 502); }
  return json({ ok: true, action: "reserved", date, slot, message: "Slot blocked. Open play can no longer book it (shows as unavailable)." });
};

// "14:30" -> 870. Accepts H:MM or HH:MM.
function hhmmToMinutes(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v || "").toString().trim());
  if (!m) return null;
  const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}
function minutesToLabel(min) {
  const hh = Math.floor(min / 60), mm = min % 60;
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/slot-block" };
