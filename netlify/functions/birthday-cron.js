// Daily scheduled job: emails each child's birthday gift code ONE WEEK before their
// birthday (so they have it in hand), plus a short happy-birthday reminder on the day.
// The code is valid the child's whole birthday WEEK (Sunday–Saturday), OPEN PLAY only,
// single-use — so a birthday on a closed day is fine; they can come any open day that week.
//
// Source of truth: the child profile (card.dob). A child with more than one
// profile (e.g. one per parent) is grouped by name + birth date: one code per
// child, sent to every email on file.
//
// Runs every day at 15:00 UTC (~8am Pacific). Netlify handles the schedule.
import { getStore } from "@netlify/blobs";
import { issueBirthdayCode, sendBirthdayEmail, sendBirthdayDayOfEmail, birthdayWeek, findExistingBirthdayReward, nextOccurrence, childNameKey } from "./lib-birthday.js";

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

  // ONE CHILD, ONE CODE. The same child can have more than one profile (Mom's and
  // Dad's, under different phone numbers). Group the profiles by child -- same
  // name + same birth date -- so the child gets ONE code, and that same code is
  // emailed to every address on file (each email BCCs the studio).
  const groups = new Map();
  for (const k of keys) {
    let card = null; try { card = await loyalty.get(k, { type: "json" }); } catch {}
    if (!card || !card.dob || !/^\d{4}-\d{2}-\d{2}$/.test(card.dob)) continue;
    card.code = card.code || k.slice(5);   // "card:" prefix is 5 chars
    const gk = childNameKey(card.childName) + "|" + card.dob;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(card);
  }

  let sent = 0, skipped = 0, failed = 0;
  let daySent = 0, daySkipped = 0, dayFailed = 0;
  let checked = 0, dayChecked = 0;

  const save = async (card) => { try { await loyalty.setJSON("card:" + card.code, card); } catch {} };
  const emailsOf = (cards) => {
    const seen = new Set(), out = [];
    for (const c of cards) {
      const e = String(c.buyerEmail || "").trim();
      if (e && !seen.has(e.toLowerCase())) { seen.add(e.toLowerCase()); out.push(e); }
    }
    return out;
  };

  for (const cards of groups.values()) {
    // Oldest profile first -- its code is the one a new birthday code is filed under.
    cards.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const lead = cards[0];
    const dob = lead.dob;
    const cmm = dob.slice(5, 7), cdd = dob.slice(8, 10);
    const allCodes = cards.map(c => c.code);
    const { first, last } = splitName(lead.childName);

    // When this child's birthday next falls, and how far off it is.
    const when = nextOccurrence(dob, todayISO);
    const year = when.slice(0, 4);
    const daysAway = Math.round(
      (Date.parse(when + "T12:00:00Z") - Date.parse(todayISO + "T12:00:00Z")) / 86400000
    );

    // Pass 1 -- heads-up email, from tomorrow up to ADVANCE_DAYS before the
    // birthday (a missed day is caught up on the next run).
    if (daysAway >= 1 && daysAway <= ADVANCE_DAYS) {
      checked++;
      const pending = cards.filter(c => c.lastSentYear !== year && c.buyerEmail);
      if (cards.some(c => c.birthdayUsedYear === year)) {
        // Already had their free birthday visit this year (e.g. a new profile
        // created at the desk on their birthday). No code, ever.
        for (const c of pending) { c.lastSentYear = year; await save(c); }
        skipped++;
      } else if (!pending.length) {
        skipped++;
      } else {
        const week = birthdayWeek(when);
        // Never hand out a second code for a birthday that's already covered.
        const existing = await findExistingBirthdayReward({
          loyaltyCodes: allCodes, childName: lead.childName, dob, validFrom: week.validFrom, validUntil: week.validUntil,
        });
        if (existing && (existing.manual || existing.used)) {
          // Staff sent it by hand (they emailed every address then), or it has
          // already been used. Nothing more to send.
          for (const c of pending) {
            c.lastSentYear = year; c.lastCode = existing.code;
            if (existing.manual) c.dayOfSentYear = year;
            await save(c);
          }
          skipped++;
        } else {
          // Claim the year on every pending profile and PERSIST IT BEFORE sending,
          // so an overlapping run stands down instead of sending twice.
          for (const c of pending) { c.lastSentYear = year; c.lastSentAt = new Date().toISOString(); await save(c); }

          let code = existing ? existing.code : "";
          if (!code) {
            const result = await issueBirthdayCode({ first, last, dob, code: lead.code }, week, lead.code, { sendEmail: false });
            if (result.ok) code = result.code;
          }
          if (code) {
            // Same code to every address that hasn't had it yet.
            const already = new Set(emailsOf(cards.filter(c => !pending.includes(c) && c.lastSentYear === year)).map(e => e.toLowerCase()));
            let anyOk = false;
            for (const email of emailsOf(pending)) {
              if (already.has(email.toLowerCase())) continue;
              const ok = await sendBirthdayEmail({ first, last, email, dob }, code, week).catch(() => false);
              if (ok) { anyOk = true; sent++; } else failed++;
            }
            for (const c of cards) {
              c.lastCode = code; c.activeBirthdayCode = code; c.activeBirthdayExpiry = week.validUntil;
              await save(c);
            }
            if (!anyOk && !emailsOf(pending).length) skipped++;
          } else {
            // Issuing failed: release the claim so tomorrow retries.
            for (const c of pending) { c.lastSentYear = undefined; await save(c); }
            failed++;
          }
        }
      }
    }

    // Pass 2 -- day-of reminder, reusing the child's code.
    if (cmm === todayMM && cdd === todayDD) {
      dayChecked++;
      const pending = cards.filter(c => c.dayOfSentYear !== todayYear && c.buyerEmail);
      if (!pending.length) { daySkipped++; continue; }
      if (cards.some(c => c.birthdayUsedYear === todayYear)) {
        for (const c of pending) { c.dayOfSentYear = todayYear; await save(c); }
        daySkipped++;
        continue;
      }
      const week = birthdayWeek(todayISO);
      const existing = await findExistingBirthdayReward({
        loyaltyCodes: allCodes, childName: lead.childName, dob, validFrom: week.validFrom, validUntil: week.validUntil,
      });
      // Hand-issued (family already told) or already used: send nothing.
      if (existing && (existing.manual || existing.used)) {
        for (const c of pending) { c.dayOfSentYear = todayYear; await save(c); }
        daySkipped++;
        continue;
      }
      // Claim the day BEFORE sending.
      for (const c of pending) { c.dayOfSentYear = todayYear; await save(c); }

      let code = existing ? existing.code : "";
      if (!code) {
        // sendEmail:false -- this pass sends its own "it's today" email below.
        const result = await issueBirthdayCode({ first, last, dob, code: lead.code }, week, lead.code, { sendEmail: false });
        if (result.ok) code = result.code;
      }
      if (code) {
        for (const email of emailsOf(pending)) {
          const ok = await sendBirthdayDayOfEmail({ first, email }, code, todayISO, week.validUntil).catch(() => false);
          if (ok) daySent++; else dayFailed++;
        }
        for (const c of cards) {
          if (c.lastSentYear !== todayYear) { c.lastSentYear = todayYear; c.lastSentAt = new Date().toISOString(); }
          c.lastCode = code; c.activeBirthdayCode = code; c.activeBirthdayExpiry = week.validUntil;
          await save(c);
        }
      } else {
        for (const c of pending) { c.dayOfSentYear = undefined; await save(c); }   // retry tomorrow
        dayFailed++;
      }
    }
  }

  return new Response(JSON.stringify({
    ok: true, advanceDays: ADVANCE_DAYS, checked, sent, skipped, failed,
    today: todayISO, dayChecked, daySent, daySkipped, dayFailed,
  }), { status: 200, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 15 * * *" };
