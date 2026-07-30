// POST /api/sales-tax-report  (admin key or staff PIN)
// Computes ACTUAL total sales / tax collected from Open Play website bookings,
// straight from the studio's own records — independent of how Square categorizes
// the charge (Square currently lumps these into "Custom Amount" with no tax
// itemization, so its own reports understate collected tax; this reads the truth
// from what was actually calculated and charged at checkout).
//
// Maps directly onto CDTFA's Sales and Use Tax Return fields:
//   "Total Sales"                      = totalAmount  (admission + tax, what was charged)
//   "Sales Tax (if any) Included in
//    Total Sales" (a deduction line)   = totalTax
//   (Total Sales − that deduction) is your net taxable measure.
//
// NOTE: this only covers Open Play bookings. Party bookings currently do not
// have tax calculated on them at all (a separate, known gap) and are not
// included here — see the "Weekday special" section notes in this codebase for
// context on what does and doesn't have tax applied.
//
// Body: { key, action:"report", startDate, endDate }   (YYYY-MM-DD, inclusive)
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const startDate = (b.startDate || "").toString();
  const endDate = (b.endDate || "").toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return json({ error: "Pick a valid start and end date." }, 400);
  }

  const store = getStore("bookings");
  const keys = await listAllKeys(store);

  const byMonth = {};   // "YYYY-MM" -> { amount, tax, taxable, count }
  let totalAmount = 0, totalTax = 0, count = 0;
  const rows = [];      // per-booking detail, for the CSV export

  for (const k of keys) {
    const date = (k.split("__")[0] || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDate || date > endDate) continue;
    let rec = null; try { rec = await store.get(k, { type: "json" }); } catch {}
    if (!rec || !Array.isArray(rec.bookings)) continue;

    for (const entry of rec.bookings) {
      const amount = Number(entry.amount) || 0;
      const tax = Number(entry.tax) || 0;
      if (amount <= 0 && tax <= 0) continue;   // fully covered by pass/reward — nothing charged, nothing taxed
      const taxable = amount - tax;
      const month = date.slice(0, 7);
      if (!byMonth[month]) byMonth[month] = { amount: 0, tax: 0, taxable: 0, count: 0 };
      byMonth[month].amount += amount; byMonth[month].tax += tax; byMonth[month].taxable += taxable; byMonth[month].count++;
      totalAmount += amount; totalTax += tax; count++;
      rows.push({ date, id: entry.id, name: entry.name || "", amount, tax, taxable });
    }
  }

  const monthly = Object.keys(byMonth).sort().map(m => ({ month: m, ...byMonth[m] }));
  rows.sort((a, c) => a.date.localeCompare(c.date));

  return json({
    ok: true, startDate, endDate, count,
    totals: { amount: totalAmount, tax: totalTax, taxable: totalAmount - totalTax },
    monthly, rows,
    note: "Open Play website bookings only. Party bookings are not included — tax is not currently calculated on those (a separate, known gap).",
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/sales-tax-report" };
