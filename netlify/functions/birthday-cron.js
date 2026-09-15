// Daily scheduled job: emails each child's birthday gift code ONE WEEK before their
// birthday (so they have it in hand), plus a short happy-birthday reminder on the day.
// The code is valid the child's whole birthday WEEK (Sunday–Saturday), OPEN PLAY only,
// single-use — so a birthday on a closed day is fine; they can come any open day that week.
//
// Source of truth: the loyalty card record itself (card.dob). One card = one
// child, one code, one place with their birthday, punches, and gift-code history.
//
// Runs every day at 15:00 UTC (~8am Pacific). Netlify handles the schedule.
import { getStore } from "@netlify/blobs";
import { issueBirthdayCode, sendBirthdayDayOfEmail, birthdayWeek, findExistingBirthdayReward, nextOccurrence } from "./lib-birthday.js";

function splitName(childName) {
  const parts = (childName || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "" };
}

// How far ahead the heads-up email goes out. Families asked for enough notice to
// plan and book, not a day or two.
const ADVANCE_DAYS = 10;

export default async () => {
  const today = new Date();

  const todayMM = String(today.getUTCMonth() + 1).padStart(2, "0");
  const todayDD = String(today.getUTCDate()).padStart(2, "0");
  const todayISO = `${today.getUTCFullYear()}-${todayMM}-${todayDD}`;
  const todayYear = todayISO.slice(0, 4);

  const loyalty = getStore("loyalty");
  let keys = [];
  try { const r = await loyalty.list({ prefix: "card:" }); keys = (r.blobs || []).map(x => x.key); } catch {}

  let sent = 0, skipped = 0, failed = 0;
  let daySent = 0, daySkipped = 0, dayFailed = 0;
  let checked = 0, dayChecked = 0;

  for (const k of keys) {
    let card = null; try { card = await loyalty.get(k, { type: "json" }); } catch {}
    if (!card || !card.dob) continue;
    const cmm = card.dob.slice(5, 7), cdd = card.dob.slice(8, 10);
    const loyaltyCode = card.code || k.slice(5); // "card:" prefix is 5 chars
    let touched = false;

    // When this child's birthday next falls, and how far off it is.
    const when = nextOccurrence(card.dob, todayISO);
    const year = when.slice(0, 4);
    const daysAway = Math.round(
      (Date.parse(when + "T12:00:00Z") - Date.parse(todayISO + "T12:00:00Z")) / 86400000
    );

    // Pass 1 — heads-up email, ADVANCE_DAYS before the birthday.
    //
    // This used to fire ONLY on the single day that was exactly 7 days out. Miss
    // that one day -- a birthday added to the system later than that, a cron run
    // that didn't happen, a deploy -- and the family got no advance notice at
    // all, just the day-of email. That is what happened to Aurora: her birthday
    // landed on a Saturday, the heads-up never fired, and the only email she got
    // arrived on the last day the code was valid.
    //
    // It now fires for any birthday from tomorrow up to ADVANCE_DAYS away, so a
    // missed day is caught up on the next run instead of being lost for a year.
    if (daysAway >= 1 && daysAway <= ADVANCE_DAYS) {
      checked++;
      if (card.lastSentYear !== year && card.buyerEmail) {
        const week = birthdayWeek(when);
        // Never hand out a second code for a birthday that's already covered —
        // most often because staff issued one by hand before the DOB was on file.
        const existing = await findExistingBirthdayReward({
          loyaltyCode, childName: card.childName, validFrom: week.validFrom, validUntil: week.validUntil,
        });
        if (existing) {
          card.lastSentYear = year;
          card.lastCode = existing.code;
          // A hand-issued code means the family has already been told. Don't send
          // the day-of reminder either.
          if (existing.manual) card.dayOfSentYear = year;
          touched = true;
          skipped++;
        } else {
          // Claim the year and PERSIST IT BEFORE sending anything. The year used
          // to be written only after the email went out, and saved once at the
          // very end -- so two runs a minute apart both read "not sent yet",
          // both minted a code, and both emailed. Claiming first means the
          // second run sees the claim and stands down.
          card.lastSentYear = year;
          card.lastSentAt = new Date().toISOString();
          try { await loyalty.setJSON(k, card); } catch {}

          const { first, last } = splitName(card.childName);
          const result = await issueBirthdayCode({ first, last, email: card.buyerEmail, dob: card.dob, code: loyaltyCode }, week, loyaltyCode);
          if (result.ok) {
            card.lastCode = result.code;
            touched = true;
            if (result.emailed) sent++; else failed++;
          } else {
            // Issuing failed, so release the claim and let tomorrow retry rather
            // than silently skipping this child's birthday for the year.
            card.lastSentYear = undefined;
            touched = true;
            failed++;
          }
        }
      } else skipped++;
    }

    // Pass 2 — day-of reminder, reusing the already-issued code if there is one
    // (falls back to issuing a fresh code if the birthday is <7 days after signup).
    if (cmm === todayMM && cdd === todayDD) {
      dayChecked++;
      if (card.dayOfSentYear !== todayYear && card.buyerEmail) {
        const week = birthdayWeek(todayISO);
        const existing = await findExistingBirthdayReward({
          loyaltyCode, childName: card.childName, validFrom: week.validFrom, validUntil: week.validUntil,
        });
        // Hand-issued code: the family already has it. Mark the day as handled and
        // send nothing at all.
        if (existing && existing.manual) {
          card.dayOfSentYear = todayYear;
          touched = true;
          daySkipped++;
          if (touched) { try { await loyalty.setJSON(k, card); } catch {} }
          continue;
        }
        // Claim the day BEFORE sending, for the same reason as the pass above.
        card.dayOfSentYear = todayYear;
        touched = true;
        try { await loyalty.setJSON(k, card); } catch {}

        // Otherwise reuse whatever code already exists rather than minting a new one.
        let code = (card.lastSentYear === todayYear ? card.lastCode : "") || (existing ? existing.code : "");
        if (!code) {
          const { first, last } = splitName(card.childName);
          // sendEmail:false -- this pass sends its own "it's today" email just
          // below. Letting the issuer email as well is what delivered the same
          // code twice, under two different subject lines.
          const result = await issueBirthdayCode(
            { first, last, email: card.buyerEmail, dob: card.dob, code: loyaltyCode },
            week, loyaltyCode, { sendEmail: false }
          );
          if (result.ok) {
            code = result.code;
            card.lastSentYear = todayYear;
            card.lastCode = code;
            card.lastSentAt = new Date().toISOString();
          }
        }
        if (code) {
          const { first } = splitName(card.childName);
          const emailed = await sendBirthdayDayOfEmail({ first, email: card.buyerEmail }, code, todayISO, birthdayWeek(todayISO).validUntil).catch(() => false);
          if (emailed) daySent++; else dayFailed++;
        } else {
          card.dayOfSentYear = undefined;   // release the claim so tomorrow retries
          dayFailed++;
        }
      } else daySkipped++;
    }

    if (touched) { try { await loyalty.setJSON(k, card); } catch {} }
  }

  return new Response(JSON.stringify({
    ok: true, advanceDays: ADVANCE_DAYS, checked, sent, skipped, failed,
    today: todayISO, dayChecked, daySent, daySkipped, dayFailed,
  }), { status: 200, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 15 * * *" };
