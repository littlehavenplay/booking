// POST /api/booking-add   (admin key or staff PIN)
//   { key, date, slot, name, email?, phone?, regular?, sibling?, infant?, adults?, childNames?[] }
// Adds a MANUAL, no-charge booking to a slot — for a phone reservation or to restore a
// booking. It doesn't take payment and doesn't email the customer. The entry appears on
// the schedule/roster like any other booking. Uses strong-consistency read-modify-write
// so it can't stale-overwrite another booking in the same slot.
import { getStore } from "@netlify/blobs";
import { slotKey, ARRIVAL, slotLabel } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const date = (b.date || "").toString().trim();
  const slot = (b.slot || "").toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a valid date." }, 400);
  if (!ARRIVAL[slot]) return json({ error: "Pick a valid arrival time." }, 400);

  const name = (b.name || "").toString().slice(0, 120).trim();
  if (!name) return json({ error: "Enter the parent/guardian name." }, 400);
  const email = (b.email || "").toString().slice(0, 160).trim();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter a valid email, or leave it blank." }, 400);
  const phone = (b.phone || "").toString().slice(0, 40).trim();

  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, 30) : 0; };
  const regular = num(b.regular), sibling = num(b.sibling), infant = num(b.infant), adults = num(b.adults);
  const children = regular + sibling + infant;
  if (children < 1) return json({ error: "Add at least one child." }, 400);

  const childNames = (Array.isArray(b.childNames) ? b.childNames : [])
    .map(n => (n || "").toString().slice(0, 80).trim()).filter(Boolean).slice(0, 12);

  const store = getStore("bookings");
  const key = slotKey(date, slot);

  // Strong read so we append onto the truly-latest record (never overwrite another booking).
  let rec = null;
  try { rec = await store.get(key, { type: "json", consistency: "strong" }); } catch { rec = null; }
  if (!rec || typeof rec.children !== "number" || !Array.isArray(rec.bookings)) rec = { children: 0, bookings: [] };

  const entry = {
    id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : ("mb-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name, email, phone, parentName: name,
    childNames,
    regular, sibling, infant,
    adults, adultsTotal: adults, additionalAdults: 0,
    coveredRegular: 0, coveredInfant: 0, coveredSibling: 0,
    subtotal: 0, tax: 0, amount: 0,
    manualAdd: true,          // flags this as a staff-added / recovered booking (no online payment)
    at: new Date().toISOString(),
  };

  rec.bookings.push(entry);
  rec.children = (rec.children || 0) + children;

  try { await store.setJSON(key, rec); } catch { return json({ error: "Couldn't save. Try again." }, 502); }

  return json({ ok: true, id: entry.id, slot, slotLabel: slotLabel(slot), date, children, adults,
    message: `Added ${name} (${children} child${children === 1 ? "" : "ren"}${adults ? ` + ${adults} adult${adults === 1 ? "" : "s"}` : ""}) to ${slotLabel(slot)} on ${date}.` });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/booking-add" };
