// Daily scheduled job: reminds anyone sitting on an unused, unexpired store
// credit before it's too late — once with about a week left, once the day
// before it expires. Applies to ANY active credit (no-show courtesy credits,
// staff-issued credits, cancellation credits) as long as we know their email.
//
// Runs once a day. Each credit gets each reminder at most once (tracked on the
// record itself), so re-runs are safe.
import { getStore } from "@netlify/blobs";
import { pacificToday } from "./lib-settings.js";
import { sendCreditReminderEmail } from "./lib-credit.js";

function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}

export default async () => {
  const today = pacificToday();
  const store = getStore("credits");
  let keys = [];
  try { const r = await store.list({ prefix: "credit:" }); keys = (r.blobs || []).map(x => x.key); } catch {}

  let checked = 0, weekSent = 0, daySent = 0, failed = 0, skippedNoEmail = 0;

  for (const k of keys) {
    let rec = null; try { rec = await store.get(k, { type: "json" }); } catch {}
    if (!rec) continue;
    if (rec.active === false || !(rec.amount > 0) || !rec.expiry) continue;   // fully used, deactivated, or malformed
    if (rec.expiry < today) continue;                                         // already expired — nothing to remind about
    if (!rec.email) { skippedNoEmail++; continue; }                           // no address on file (older credits pre-dating this)
    checked++;

    const daysLeft = daysBetween(today, rec.expiry);
    let touched = false;

    // ~1 week out (a small window so a missed cron run doesn't skip the reminder entirely)
    if (daysLeft >= 6 && daysLeft <= 7 && !rec.reminder7SentAt) {
      const ok = await sendCreditReminderEmail(rec.email, rec, daysLeft).catch(() => false);
      rec.reminder7SentAt = new Date().toISOString();
      touched = true;
      if (ok) weekSent++; else failed++;
    }
    // Day before (or day-of, if a cron run was missed) it expires
    if (daysLeft >= 0 && daysLeft <= 1 && !rec.reminder1SentAt) {
      const ok = await sendCreditReminderEmail(rec.email, rec, daysLeft).catch(() => false);
      rec.reminder1SentAt = new Date().toISOString();
      touched = true;
      if (ok) daySent++; else failed++;
    }

    if (touched) { try { await store.setJSON(k, rec); } catch {} }
  }

  return new Response(JSON.stringify({ ok: true, today, checked, weekSent, daySent, failed, skippedNoEmail }),
    { status: 200, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 16 * * *" };   // once daily, ~9am Pacific
