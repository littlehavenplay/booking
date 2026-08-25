// POST /api/partypromo
//
// A booking-window promotion for parties: "book on Labor Day, get $100 off."
// The trigger is WHEN THE PARTY IS BOOKED, not when the party happens — someone
// booking on Labor Day for a November party qualifies.
//
// How the money actually moves: deposits are fixed Square Payment Links, so the
// deposit never changes. The promo is a recorded, tracked promise that comes off
// the BALANCE settled at the end of the party. It shows on the customer's emails
// and on the party card in staff/admin, so whoever runs the party knows.
//
// Lifecycle, and the reason it works this way:
//   booked inside the window  -> promo attached, marked pending
//   deposit marked paid       -> promo locks in, customer emailed
//   deposit never paid        -> no party, no discount
// Attaching at booking time (rather than at the moment the deposit is marked)
// means a customer doesn't lose the promo just because staff ticked the box the
// next morning. Requiring the deposit to lock it in still honours "they must pay
// the deposit to qualify."
//
// Admin actions (ADMIN_KEY only):
//   { key, action:"get" }
//   { key, action:"save", name, kind:"amount"|"percent", value, startDate, endDate, blurb, active }
//   { key, action:"clear" }
//   { key, action:"log" }              -> parties that claimed it
// Public (no key):
//   { action:"public" }                -> today's live promo, for the parties page
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";

const STORE = "partypromo";
const CURRENT = "current";

function todayPacific() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))
    .toISOString().slice(0, 10);
}

// The single source of truth for "is a promo running right now". Both the booking
// endpoint and the public banner call this, so the page can never advertise a
// promo the booking flow won't honour.
export async function getLivePartyPromo(onDate) {
  const day = onDate || todayPacific();
  try {
    const p = await getStore(STORE).get(CURRENT, { type: "json" });
    if (!p || p.active === false) return null;
    if (p.startDate && day < p.startDate) return null;
    if (p.endDate && day > p.endDate) return null;
    return p;
  } catch { return null; }
}

// What the promo is worth against a given package price (cents).
export function promoValue(promo, packagePriceCents) {
  if (!promo) return 0;
  if (promo.kind === "percent") {
    const pct = Math.max(0, Math.min(100, Number(promo.value) || 0));
    return Math.round((packagePriceCents || 0) * pct / 100);
  }
  return Math.max(0, Math.min(Number(promo.value) || 0, packagePriceCents || Number(promo.value) || 0));
}

export function promoLabel(promo) {
  if (!promo) return "";
  return promo.kind === "percent" ? `${Number(promo.value) || 0}% off` : `$${((Number(promo.value) || 0) / 100).toFixed(0)} off`;
}

export async function logPromoClaim(entry) {
  try {
    const store = getStore(STORE);
    const at = new Date().toISOString();
    await store.setJSON("claim:" + at + ":" + Math.random().toString(36).slice(2, 7), { at, ...entry });
  } catch {}
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = (b.action || "get").toString();
  const store = getStore(STORE);

  // Public: the parties page banner. No key — it only ever reveals a promo the
  // studio is actively advertising.
  if (action === "public") {
    const p = await getLivePartyPromo();
    if (!p) return json({ ok: true, promo: null });
    return json({ ok: true, promo: {
      name: p.name || "Special offer",
      label: promoLabel(p),
      blurb: p.blurb || "",
      endDate: p.endDate || null,
    } });
  }

  const adminKey = process.env.ADMIN_KEY || "";
  if (!adminKey) return json({ error: "Admin key isn't configured." }, 500);
  if ((b.key || "").toString() !== adminKey) return json({ error: "Admin key required." }, 401);

  if (action === "get" || action === "log") {
    let p = null;
    try { p = await store.get(CURRENT, { type: "json" }); } catch {}
    const claims = [];
    if (action === "log") {
      try {
        const keys = (await listAllKeys(store, { prefix: "claim:" })).sort().reverse().slice(0, 100);
        for (const k of keys) { try { const c = await store.get(k, { type: "json" }); if (c) claims.push(c); } catch {} }
      } catch {}
    }
    return json({ ok: true, promo: p || null, live: !!(await getLivePartyPromo()), claims });
  }

  if (action === "save") {
    const kind = b.kind === "percent" ? "percent" : "amount";
    const value = Math.max(0, Number(b.value) || 0);
    if (!value) return json({ error: "Enter a discount amount." }, 400);
    if (kind === "percent" && value > 100) return json({ error: "A percentage can't be over 100." }, 400);
    const startDate = (b.startDate || "").toString().slice(0, 10);
    const endDate = (b.endDate || "").toString().slice(0, 10) || startDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return json({ error: "Pick a start date." }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return json({ error: "Pick an end date." }, 400);
    if (endDate < startDate) return json({ error: "The end date can't be before the start date." }, 400);

    const rec = {
      name: (b.name || "Party special").toString().slice(0, 60),
      kind, value, startDate, endDate,
      blurb: (b.blurb || "").toString().slice(0, 200),
      active: b.active === false ? false : true,
      updatedAt: new Date().toISOString(),
    };
    try { await store.setJSON(CURRENT, rec); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, promo: rec, live: !!(await getLivePartyPromo()),
      message: `Saved. ${rec.name} — ${promoLabel(rec)} for parties booked ${startDate === endDate ? "on " + startDate : startDate + " to " + endDate}.` });
  }

  if (action === "clear") {
    try { await store.setJSON(CURRENT, { active: false, clearedAt: new Date().toISOString() }); }
    catch { return json({ error: "Couldn't clear it. Try again." }, 502); }
    return json({ ok: true, promo: null, live: false, message: "Promo turned off. Parties already booked keep their discount." });
  }

  return json({ error: "Unknown action." }, 400);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/partypromo" };
