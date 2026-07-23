// Daily scheduled job: emails each child's birthday gift code ONE WEEK before
// their birthday, then a short reminder email ON the birthday itself.
// The code itself is valid on the birthday only (single-use).
//
// Source of truth: the loyalty card record itself (card.dob). One card = one
// child, one code, one place with their birthday, punches, and gift-code history.
//
// Runs every day at 15:00 UTC (~8am Pacific). Netlify handles the schedule.
import { getStore } from "@netlify/blobs";
import { issueBirthdayCode, sendBirthdayDayOfEmail } from "./lib-birthday.js";

function splitName(childName) {
  const parts = (childName || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "" };
}

export default async () => {
  const today = new Date();
  const target = new Date(today.getTime() + 7 * 86400000);
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(target.getUTCDate()).padStart(2, "0");
  const when = `${target.getUTCFullYear()}-${mm}-${dd}`;
  const year = when.slice(0, 4);

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

    // Pass 1 — one-week-ahead heads-up email (issues the gift code).
    if (cmm === mm && cdd === dd) {
      checked++;
      if (card.lastSentYear !== year && card.buyerEmail) {
        const { first, last } = splitName(card.childName);
        const result = await issueBirthdayCode({ first, last, email: card.buyerEmail, dob: card.dob, code: loyaltyCode }, when, loyaltyCode);
        if (result.ok) {
          card.lastSentYear = year;
          card.lastCode = result.code;
          card.lastSentAt = new Date().toISOString();
          touched = true;
          if (result.emailed) sent++; else failed++;
        } else failed++;
      } else skipped++;
    }

    // Pass 2 — day-of reminder, reusing the already-issued code if there is one
    // (falls back to issuing a fresh code if the birthday is <7 days after signup).
    if (cmm === todayMM && cdd === todayDD) {
      dayChecked++;
      if (card.dayOfSentYear !== todayYear && card.buyerEmail) {
        let code = card.lastSentYear === todayYear ? card.lastCode : "";
        if (!code) {
          const { first, last } = splitName(card.childName);
          const result = await issueBirthdayCode({ first, last, email: card.buyerEmail, dob: card.dob, code: loyaltyCode }, todayISO, loyaltyCode);
          if (result.ok) {
            code = result.code;
            card.lastSentYear = todayYear;
            card.lastCode = code;
            card.lastSentAt = new Date().toISOString();
          }
        }
        if (code) {
          const { first } = splitName(card.childName);
          const emailed = await sendBirthdayDayOfEmail({ first, email: card.buyerEmail }, code, todayISO).catch(() => false);
          card.dayOfSentYear = todayYear;
          touched = true;
          if (emailed) daySent++; else dayFailed++;
        } else dayFailed++;
      } else daySkipped++;
    }

    if (touched) { try { await loyalty.setJSON(k, card); } catch {} }
  }

  return new Response(JSON.stringify({
    ok: true, when, checked, sent, skipped, failed,
    today: todayISO, dayChecked, daySent, daySkipped, dayFailed,
  }), { status: 200, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 15 * * *" };
