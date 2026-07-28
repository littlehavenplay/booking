// /api/weekday-special — an automatic (no code needed) discount applied to open
// play admissions on chosen days of the week, e.g. "25% off Regular & Baby/Infant
// admission every Monday and Tuesday." Different from the manual discount-code
// tool: this one triggers itself off the booking date, and can target specific
// admission types (Sibling add-on can be excluded, included, or the only one).
//
//   GET  → public: { ok, enabled, days:[0-6], mode:"percent"|"dollar", amount, appliesTo:{regular,sibling,infant}, label }
//   POST { key, action:"save", enabled, days, mode, amount, appliesTo, label } → admin/staff
import { getStore } from "@netlify/blobs";
import { getWeekdaySpecial } from "./lib-weekday.js";

export default async (req) => {
  if (req.method === "GET") {
    const cfg = await getWeekdaySpecial();
    return json({ ok: true, ...cfg });
  }
  if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);

  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const enabled = !!b.enabled;
  const days = Array.isArray(b.days) ? b.days.map(d => parseInt(d, 10)).filter(d => Number.isFinite(d) && d >= 0 && d <= 6) : [];
  const mode = b.mode === "dollar" ? "dollar" : "percent";
  let amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0) return json({ error: "Enter a valid amount." }, 400);
  amount = mode === "percent" ? Math.min(100, Math.round(amount)) : Math.round(amount * 100); // dollars -> cents
  const appliesTo = {
    regular: b.appliesTo ? !!b.appliesTo.regular : true,
    sibling: b.appliesTo ? !!b.appliesTo.sibling : true,
    infant: b.appliesTo ? !!b.appliesTo.infant : true,
  };
  if (enabled && !appliesTo.regular && !appliesTo.sibling && !appliesTo.infant) {
    return json({ error: "Pick at least one admission type for the special to apply to." }, 400);
  }
  const label = (b.label || "").toString().slice(0, 60).trim();

  const rec = { enabled, days, mode, amount, appliesTo, label, updatedAt: new Date().toISOString() };
  try { await getStore("site").setJSON("weekday-special", rec); }
  catch { return json({ error: "Couldn't save. Try again." }, 502); }
  return json({ ok: true, ...rec });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/weekday-special" };
