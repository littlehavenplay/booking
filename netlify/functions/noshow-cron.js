// Daily-running scheduled job (every 15 min): finds open-play bookings whose
// arrival time was more than 60 minutes ago and who were never checked in,
// auto-cancels the reservation (frees the spot), restores any punch-card
// visit used, and issues ONE courtesy store credit for the full amount paid
// — valid 15 days — so the family can rebook whenever they're ready.
//
// Shares its credit-issuing logic with reschedule.js's manual "Cancel & refund"
// flow (see lib-credit.js), so a no-show credit looks and behaves exactly like
// a staff-issued one, just with a shorter, no-show-specific expiry and message.
//
// Set NOSHOW_AUTO_CANCEL=false in Netlify env vars to pause this without
// touching code — it'll just report what it *would* have done.
import { getStore } from "@netlify/blobs";
import { ARRIVAL_IDS, arrivalStartMin, slotLabel, slotKey, pacificToday } from "./lib-settings.js";
import { makeCredit, sendCreditEmail, ownerCopy } from "./lib-credit.js";

const GRACE_MINUTES = 60;          // how late = a no-show
const CREDIT_EXPIRY_DAYS = 15;
const NOSHOW_INTRO = "We held your spot but it looks like you weren't able to make it in today — no worries, these things happen! We've gone ahead and released the reservation and set you up with a courtesy credit so you can rebook whenever works for you.";

export default async () => {
  const dryRun = (process.env.NOSHOW_AUTO_CANCEL || "true").toLowerCase() === "false";
  const today = pacificToday();
  const nowMin = pacificNowMinutes();

  const bookingsStore = getStore("bookings");
  const arrivalsStore = getStore("arrivals");
  let arrivals = {};
  try { arrivals = (await arrivalsStore.get(today, { type: "json" })) || {}; } catch {}

  let checked = 0, cancelled = 0, credited = 0, failed = 0;
  const details = [];

  for (const slotId of ARRIVAL_IDS) {
    const start = arrivalStartMin(slotId);
    if (start == null) continue;
    // Only slots at least GRACE_MINUTES past their start, and not wildly stale
    // (skip anything more than 6 hours past the mark — a sign the cron had an
    // outage; leave those for staff to review by hand instead of auto-acting).
    const lateBy = nowMin - (start + GRACE_MINUTES);
    if (lateBy < 0 || lateBy > 360) continue;

    const key = slotKey(today, slotId);
    let rec = null;
    try { rec = await bookingsStore.get(key, { type: "json" }); } catch {}
    if (!rec || !Array.isArray(rec.bookings) || !rec.bookings.length) continue;

    // Work backwards so splicing doesn't skip an entry.
    for (let i = rec.bookings.length - 1; i >= 0; i--) {
      const entry = rec.bookings[i];
      if (arrivals[entry.id]) continue;   // checked in — not a no-show
      checked++;

      const childCount = (entry.regular || 0) + (entry.sibling || 0) + (entry.infant || 0);
      const giftPaid = Array.isArray(entry.giftCards) ? entry.giftCards.reduce((n, g) => n + (g.applied || 0), 0) : 0;
      const paidCents = (entry.cardPaid || 0) + giftPaid + (entry.creditApplied || 0);
      const okEmail = entry.email && /^\S+@\S+\.\S+$/.test(entry.email);

      if (dryRun) {
        details.push({ slot: slotId, name: entry.name || "guest", id: entry.id, wouldCredit: paidCents / 100 });
        continue;
      }

      // Release the spot.
      rec.bookings.splice(i, 1);
      rec.children = Math.max(0, (rec.children || 0) - childCount);

      // Restore any punch-card visit(s) used for this booking.
      let punchesRestored = 0;
      if (Array.isArray(entry.passesUsed) && entry.passesUsed.length) {
        const passStore = getStore("passes");
        for (const p of entry.passesUsed) {
          try {
            const fresh = await passStore.get("pass:" + p.code, { type: "json" });
            if (fresh) {
              fresh.visitsRemaining = (fresh.visitsRemaining || 0) + 1;
              if (fresh.active === false) fresh.active = true;
              fresh.history = Array.isArray(fresh.history) ? fresh.history : [];
              fresh.history.push({ at: new Date().toISOString(), action: "visit-restored", where: "no-show auto-cancel" });
              await passStore.setJSON("pass:" + p.code, fresh);
              punchesRestored++;
            }
          } catch {}
        }
      }

      const reason = `No-show auto-cancel — ${entry.name || "guest"}, ${today} ${slotLabel(slotId)}`;
      let code = null;
      if (paidCents > 0) {
        const c = await makeCredit("courtesy", paidCents, reason, { custName: entry.name, email: entry.email, expiryDays: CREDIT_EXPIRY_DAYS, customIntro: NOSHOW_INTRO });
        if (c) {
          code = c.code;
          if (okEmail) { try { await sendCreditEmail(entry.email, c, false); } catch {} }
          try { await ownerCopy(c); } catch {}
          credited++;
        } else failed++;
      }

      cancelled++;
      details.push({ slot: slotId, name: entry.name || "guest", id: entry.id, creditedCents: paidCents, code, punchesRestored });
    }

    if (!dryRun) {
      try { await bookingsStore.setJSON(key, rec); } catch {}
    }
  }

  return new Response(JSON.stringify({ ok: true, dryRun, today, checked, cancelled, credited, failed, details }),
    { status: 200, headers: { "content-type": "application/json" } });
};

// Current time as minutes-since-midnight in Pacific time (matches arrivalStartMin's units).
function pacificNowMinutes() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === "hour").value, 10) % 24;
  const m = parseInt(parts.find(p => p.type === "minute").value, 10);
  return h * 60 + m;
}

export const config = { schedule: "*/15 * * * *" };
