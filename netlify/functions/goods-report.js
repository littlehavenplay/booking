// POST /api/goods-report  (admin key or staff PIN)
// Quarterly sales-tax report for TAXABLE GOODS sold through online booking.
//
// Admission is exempt (CDTFA treats recreational admission as intangible), but
// physical goods — grip socks today, snacks and juice boxes later — are not.
// The studio absorbs the tax rather than charging customers, so the price paid
// is treated as tax-INCLUDED and the tax is backed out of it:
//
//     taxable base = gross / (1 + rate)
//     tax owed     = gross - base
//
// Every booking stores the quantity AND the amount actually paid, so a price
// change is handled by grouping on the unit price that was really charged
// rather than today's price. That is what makes the $2.50 / $3.00 split
// possible retrospectively — nothing had to be back-filled.
//
// Body: { key, from: "YYYY-MM-DD", to: "YYYY-MM-DD", rate?: 0.0875 }

import { getStore } from "@netlify/blobs";

// Adding a new taxable item later is a one-line change here. Bookings that
// predate the field simply contribute nothing, so old data stays correct.
//   field       - quantity field on the booking record
//   amountField - total cents paid for that line on that booking
const GOODS = [
  { id: "gripSocks", field: "gripSocks", amountField: "gripSocksAmount", label: "Grip socks", unit: "pair" },
  { id: "snacks",    field: "snacks",    amountField: "snacksAmount",    label: "Snacks",     unit: "item" },
  { id: "juice",     field: "juiceBoxes", amountField: "juiceBoxesAmount", label: "Juice boxes", unit: "box" },
];

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

function eachDate(from, to) {
  const out = [];
  const d = new Date(from + "T00:00:00Z"), end = new Date(to + "T00:00:00Z");
  // Hard stop so a typo like 2026 -> 2126 can't spin for ever.
  for (let i = 0; d <= end && i < 800; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Pure aggregation, kept separate from storage so the arithmetic can be tested
// directly against known input instead of behind a mocked blob store.
export function aggregate(records, rate) {
  const rows = new Map();
  let bookingsWithGoods = 0;

  for (const rec of records) {
    if (!rec || !Array.isArray(rec.bookings)) continue;
    for (const bk of rec.bookings) {
      if (bk && bk.cancelled) continue;              // a cancelled booking sold nothing
      let counted = false;

      for (const g of GOODS) {
        const qty = Math.max(0, parseInt(bk?.[g.field], 10) || 0);
        if (!qty) continue;
        counted = true;

        const amount = Number.isFinite(bk?.[g.amountField]) ? Math.max(0, bk[g.amountField]) : null;
        // Unit price actually charged. Older records that stored a quantity but
        // no amount are bucketed as "unknown" rather than valued at today's
        // price -- a guess here would misstate a tax return.
        const unit = (amount != null && qty > 0) ? Math.round(amount / qty) : null;
        const id = `${g.id}@${unit == null ? "unknown" : unit}`;

        if (!rows.has(id)) {
          rows.set(id, { goodsId: g.id, label: g.label, unitLabel: g.unit, unitCents: unit, qty: 0, grossCents: 0 });
        }
        const row = rows.get(id);
        row.qty += qty;
        row.grossCents += (amount != null ? amount : 0);
      }
      if (counted) bookingsWithGoods++;
    }
  }

  const out = [...rows.values()]
    .sort((a, b) => a.label.localeCompare(b.label) || (b.unitCents || 0) - (a.unitCents || 0))
    .map(r => {
      const base = Math.round(r.grossCents / (1 + rate));
      return { ...r, taxableBaseCents: base, taxOwedCents: r.grossCents - base };
    });

  const totals = out.reduce((a, r) => ({
    qty: a.qty + r.qty,
    grossCents: a.grossCents + r.grossCents,
    taxableBaseCents: a.taxableBaseCents + r.taxableBaseCents,
    taxOwedCents: a.taxOwedCents + r.taxOwedCents,
  }), { qty: 0, grossCents: 0, taxableBaseCents: 0, taxOwedCents: 0 });

  return { rows: out, totals, bookingsWithGoods };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const from = (b.from || "").toString().trim();
  const to   = (b.to || "").toString().trim();
  if (!isDate(from) || !isDate(to)) return json({ error: "Pick a start and end date." }, 400);
  if (from > to) return json({ error: "The start date is after the end date." }, 400);

  const rate = (() => {
    const r = Number(b.rate);
    if (Number.isFinite(r) && r >= 0 && r < 0.25) return r;
    return Number(process.env.SALES_TAX_RATE || 0.0875);
  })();

  const bookings = getStore("bookings");
  const days = eachDate(from, to);

  const records = [];
  let daysScanned = 0;
  for (const date of days) {
    let keys = [];
    try {
      const r = await bookings.list({ prefix: date + "__" });
      keys = (r.blobs || []).map(x => x.key);
    } catch { keys = []; }
    daysScanned++;
    for (const k of keys) {
      let rec = null;
      try { rec = await bookings.get(k, { type: "json" }); } catch { rec = null; }
      if (rec) records.push(rec);
    }
  }

  const { rows: out, totals, bookingsWithGoods } = aggregate(records, rate);

  return json({
    ok: true, from, to, rate, daysScanned, bookingsWithGoods,
    rows: out, totals,
    // Said plainly so the number is never mistaken for the whole picture.
    note: "Covers goods bought through online booking only. Anything sold at the counter on the Square terminal is not included here.",
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export const config = { path: "/api/goods-report" };
