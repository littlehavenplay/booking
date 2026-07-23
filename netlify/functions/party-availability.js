// GET /api/party-availability?date=YYYY-MM-DD
// Returns the 4 party slots for a Fri/Sat/Sun date with whether each is taken.

import { getStore } from "@netlify/blobs";
import { PARTY_SLOTS, PARTY_SLOT_IDS, isPartyDay, PARTY_BOOKING_MIN_DAYS, slotKey, PARTY_PACKAGES } from "./lib-settings.js";

export default async (req) => {
  const url = new URL(req.url);
  const date = (url.searchParams.get("date") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "A valid ?date=YYYY-MM-DD is required." }, 400);

  const partyDay = isPartyDay(date);
  const minStr = new Date(Date.now() + PARTY_BOOKING_MIN_DAYS * 86400000).toISOString().slice(0, 10);
  const tooSoon = date < minStr;

  const parties = getStore("parties");
  const slots = [];
  for (const s of PARTY_SLOTS) {
    let taken = false;
    try { taken = !!(await parties.get(slotKey(date, s.id), { type: "json" })); } catch { taken = false; }
    slots.push({ id: s.id, label: s.label, available: partyDay && !tooSoon && !taken, taken });
  }

  const packages = Object.entries(PARTY_PACKAGES).map(([id, p]) => ({ id, label: p.label, deposit: p.deposit }));
  return json({ date, partyDay, tooSoon, minDate: minStr, slots, packages });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/party-availability" };
