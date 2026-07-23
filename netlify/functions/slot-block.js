// POST /api/slot-block   (protected by ADMIN_KEY)
// Body: { key, date, slot, action: "reserve" | "release", note }
// Reserves (or releases) a specific date + time slot for a private party so it
// is no longer bookable for open play. Use once a party deposit is paid.

import { getStore } from "@netlify/blobs";
import { SLOT_IDS, PARTY_SLOT_IDS, PARTY_SLOTS, isPartyDay, slotKey } from "./lib-settings.js";

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
  const action = (b.action || "reserve").trim();
  const note = (b.note || "").toString().slice(0, 200).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a valid date." }, 400);

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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/slot-block" };
