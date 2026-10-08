// Shared birthday-gift helpers, used by /api/birthdays and the daily scheduled sender.
// A birthday gift code reuses the free-visit reward mechanism (one free child admission,
// OPEN PLAY only). It's valid the child's whole birthday WEEK (Sunday–Saturday), so a
// birthday landing on a closed day is no problem — they can come any open day that week.
// Single-use. `when` may be a single "YYYY-MM-DD" or a { validFrom, validUntil } range.
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { fromHeader, SIGNATURE_HTML, resendEmail } from "./lib-email.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1

// The next time this birthday comes around (today counts).
export function nextOccurrence(dob, todayISO) {
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const mmdd = dob.slice(5);
  const thisYear = today.slice(0, 4);
  const candidate = thisYear + "-" + mmdd;
  return candidate >= today ? candidate : (Number(thisYear) + 1) + "-" + mmdd;
}

export function ageOn(dob, onDate) {
  return Number(onDate.slice(0, 4)) - Number(dob.slice(0, 4));
}

// The calendar week (Sunday–Saturday) containing a date. The birthday gift is valid this
// whole week, so families can come any open-play day — even if the birthday itself lands
// on a day we're closed.
export function birthdayWeek(dateISO) {
  const d = new Date(dateISO + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0 = Sunday
  const sun = new Date(d.getTime() - dow * 86400000);
  const sat = new Date(sun.getTime() + 6 * 86400000);
  return { validFrom: sun.toISOString().slice(0, 10), validUntil: sat.toISOString().slice(0, 10) };
}

// `when` can be a single "YYYY-MM-DD" string (the existing automatic birthday
// flow — validFrom and expiry both land on that one day, unchanged behavior),
// or an object { validFrom, validUntil } for a custom multi-day window (the
// manual staff tool, e.g. covering a birthday that falls on a closed Monday).
// Has this child ALREADY got a birthday code covering this window?
//
// This is the backstop that stops a family ever receiving two codes for one
// birthday. It reads the rewards store directly instead of trusting a flag on the
// loyalty card, so it still works when staff issued a code by hand for a child who
// had no card yet, or whose birthday wasn't on file at the time.
//
// Matches on the loyalty code when there is one, otherwise on the child's name.
// Name-only matching could in theory collide for two children with identical names;
// the cost of that is one missed email, never a duplicate code — the right way round.
// ONE CHILD = ONE BIRTHDAY CODE (Oct 2026).
// The same child can be on file more than once -- e.g. Mom's profile and Dad's
// profile each list Grace, under two different phone numbers. Those used to be
// treated as two children, so each parent got a DIFFERENT code (two free visits).
// A child is now identified by NAME + BIRTH DATE as well as by profile code, so
// every profile for that child shares one code, and the same code is emailed to
// every address on file.
export function childNameKey(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function sameBirthdayChild(r, { loyaltyCodes, childName, dob }) {
  const codes = (loyaltyCodes || []).map(c => String(c || "").trim().toUpperCase()).filter(Boolean);
  if (codes.length && r.loyaltyCode && codes.includes(String(r.loyaltyCode).trim().toUpperCase())) return true;
  const want = childNameKey(childName);
  if (!want || childNameKey(r.childName) !== want) return false;
  // Same name but a different birth date on file = a different child.
  if (dob && r.dob && dob !== r.dob) return false;
  return true;
}

// Every birthday reward for this child whose window overlaps validFrom..validUntil.
export async function findBirthdayRewards({ loyaltyCode, loyaltyCodes, childName, dob, validFrom, validUntil }) {
  const rewards = getStore("rewards");
  const codes = (loyaltyCodes || []).concat(loyaltyCode ? [loyaltyCode] : []);
  let keys = [];
  try { keys = await listAllKeys(rewards, { prefix: "reward:" }); } catch { return []; }
  const out = [];
  for (const k of keys) {
    let r = null;
    try { r = await rewards.get(k, { type: "json" }); } catch { continue; }
    if (!r || r.kind !== "birthday") continue;
    if (!sameBirthdayChild(r, { loyaltyCodes: codes, childName, dob })) continue;
    const rFrom = r.validFrom || "", rUntil = r.expiry || r.validFrom || "";
    if (rFrom && validUntil && rFrom > validUntil) continue;
    if (rUntil && validFrom && rUntil < validFrom) continue;
    out.push(r);
  }
  // Oldest first, so every caller settles on the same code.
  out.sort((a, b) => String(a.issuedAt || "").localeCompare(String(b.issuedAt || "")));
  return out;
}

// Has this child ALREADY got a birthday code covering this window?
// This is the backstop that stops a family ever receiving two codes for one
// birthday. It reads the rewards store directly instead of trusting a flag on the
// profile, so it still works when staff issued a code by hand.
export async function findExistingBirthdayReward(opts) {
  const all = await findBirthdayRewards(opts);
  return all.length ? all[0] : null;
}

// Every profile on file for this child. Same child =
//   same name + same birth date (any family/phone -- e.g. Mom's and Dad's), or
//   same name + same phone or email when one of the profiles has no birth date
//   on it (e.g. a profile made at the desk without the birthday filled in).
export function sameChildCard(c, { code, childName, dob, phone4, email }) {
  const cc = c.code || "";
  if (code && cc === code) return true;
  const want = childNameKey(childName);
  if (!want || childNameKey(c.childName) !== want) return false;
  if (dob && c.dob) return c.dob === dob;
  const em = String(email || "").trim().toLowerCase();
  return !!((phone4 && c.phone4 === phone4) || (em && String(c.buyerEmail || "").trim().toLowerCase() === em));
}
export async function findChildCards(loyalty, { code, childName, dob, phone4, email }) {
  // Fill in what we know about this child from their own profile.
  if (code && (!childName || phone4 === undefined)) {
    try {
      const own = await loyalty.get("card:" + code, { type: "json" });
      if (own) {
        childName = childName || own.childName; dob = dob || own.dob || "";
        phone4 = phone4 || own.phone4 || ""; email = email || own.buyerEmail || "";
      }
    } catch {}
  }
  const out = [];
  let keys = [];
  try { keys = await listAllKeys(loyalty, { prefix: "card:" }); } catch {}
  for (const k of keys) {
    let c = null; try { c = await loyalty.get(k, { type: "json" }); } catch { continue; }
    if (!c) continue;
    c.code = c.code || k.slice(5);
    if (sameChildCard(c, { code, childName, dob, phone4, email })) out.push(c);
  }
  return out;
}

// The child used their free birthday visit (at the desk, or a code online).
// Retire every OTHER birthday code for that child for the same birthday, and mark
// every profile for that child so no new code is emailed this year.
export async function markBirthdayUsed({ loyaltyCodes, childName, dob, year, exceptCode, usedBy, reason }) {
  const y = String(year || new Date().toISOString().slice(0, 4));
  const burned = [];
  try {
    const rewards = getStore("rewards");
    const list = await findBirthdayRewards({ loyaltyCodes, childName, dob, validFrom: y + "-01-01", validUntil: y + "-12-31" });
    for (const r of list) {
      if (r.used || r.code === exceptCode) continue;
      r.used = true; r.usedAt = new Date().toISOString(); r.usedBy = usedBy || "";
      r.voidedReason = reason || "Birthday visit already used";
      try { await rewards.setJSON("reward:" + r.code, r); burned.push(r.code); } catch {}
    }
  } catch {}
  try {
    const loyalty = getStore("loyalty");
    const seen = new Set();
    const cards = [];
    for (const lc of (loyaltyCodes || []).filter(Boolean)) {
      for (const c of await findChildCards(loyalty, { code: lc, childName, dob: dob || undefined })) {
        if (!seen.has(c.code)) { seen.add(c.code); cards.push(c); }
      }
    }
    if (!cards.length && dob) for (const c of await findChildCards(loyalty, { childName, dob })) cards.push(c);
    for (const c of cards) {
      c.birthdayUsedYear = y; c.lastSentYear = y; c.dayOfSentYear = y;
      if (!c.birthdayUsedAt || String(c.birthdayUsedAt).slice(0, 4) !== y) c.birthdayUsedAt = new Date().toISOString();
      delete c.activeBirthdayCode; delete c.activeBirthdayExpiry;
      try { await loyalty.setJSON("card:" + c.code, c); } catch {}
    }
  } catch {}
  return burned;
}

// Has this child already had their free birthday visit in `year`? Checks every
// profile for the child and every birthday code issued to them.
export async function birthdayUsedThisYear(loyalty, { code, childName, dob, year }) {
  const y = String(year);
  const cards = await findChildCards(loyalty, { code, childName, dob });
  const hit = cards.find(c => c.birthdayUsedYear === y);
  if (hit) return { used: true, at: hit.birthdayUsedAt || "", how: "birthday visit" };
  const list = await findBirthdayRewards({ loyaltyCodes: cards.map(c => c.code).concat(code ? [code] : []), childName, dob,
    validFrom: y + "-01-01", validUntil: y + "-12-31" });
  const usedR = list.find(r => r.used && !r.voidedReason);
  if (usedR) return { used: true, at: usedR.usedAt || "", how: "birthday code " + usedR.code };
  return { used: false };
}

export async function issueBirthdayCode(rec, when, loyaltyCode, meta = {}) {
  const isRange = when && typeof when === "object";
  const validFrom = isRange ? when.validFrom : when;
  const validUntil = isRange ? (when.validUntil || when.validFrom) : when;

  // Last line of defence against a second code for the same birthday. Callers
  // check too, but this function used to mint unconditionally, so any caller
  // that forgot -- or two runs racing each other -- produced a duplicate free
  // admission. Reuse beats minting every time.
  if (!meta.forceNew) {
    try {
      const already = await findExistingBirthdayReward({
        loyaltyCode: loyaltyCode || rec.code || null,
        childName: ((rec.first || "") + " " + (rec.last || "")).trim(),
        dob: rec.dob || "",
        validFrom, validUntil,
      });
      if (already && already.code) {
        // Reuse the code, but STILL SEND if the caller wants an email. Returning
        // emailed:false here made the staff tool report "Could not email" when
        // nothing had failed -- the child simply already had a code for that
        // week. A manual re-issue is precisely when you want it sent again.
        let emailed = false;
        if (meta.sendEmail !== false) {
          try {
            emailed = await sendBirthdayEmail(rec, already.code,
              isRange ? { validFrom, validUntil } : when, { forceSend: !!meta.manual });
          } catch {}
        }
        return { ok: true, code: already.code, emailed, reused: true, validFrom, validUntil };
      }
    } catch {}
  }

  const rewards = getStore("rewards");
  const childKey = ((loyaltyCode || rec.code || "") + "|" +
                    ((rec.first || "") + " " + (rec.last || "")).trim().toLowerCase() + "|" + validFrom);

  // DETERMINISTIC code, derived from the child and the birthday week.
  //
  // The old version picked at random. Two cron runs overlapping -- both reading
  // "no code yet" before either had written -- therefore minted two DIFFERENT
  // codes, and the family got two free admissions. Checking-then-writing can
  // never fix that on its own, because the check and the write aren't atomic.
  //
  // Deriving the code instead means concurrent runs compute the SAME string and
  // write the same record, so the duplicate collapses into one by construction.
  // Collisions between different children are still handled: if the derived key
  // is taken by somebody else, we walk to the next derived candidate.
  const hash = (str) => {
    let h = 2166136261 >>> 0;                       // FNV-1a
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  };
  const derive = (salt) => {
    let h = hash(childKey + "#" + salt), out = "BDAY";
    for (let j = 0; j < 4; j++) { out += ALPHABET[h % ALPHABET.length]; h = Math.floor(h / ALPHABET.length) + hash(out); }
    return out;
  };

  let code = "";
  for (let i = 0; i < 12; i++) {
    const cand = derive(i);
    let exists = null; try { exists = await rewards.get("reward:" + cand, { type: "json" }); } catch {}
    if (!exists) { code = cand; break; }
    // Same child, same birthday week -> this IS their code. Reuse it.
    const sameChild = (exists.loyaltyCode || "") === (loyaltyCode || rec.code || "") &&
                      (exists.validFrom || "") === validFrom;
    if (sameChild) {
      let emailed = false;
      if (meta.sendEmail !== false) {
        try {
          emailed = await sendBirthdayEmail(rec, cand,
            isRange ? { validFrom, validUntil } : when, { forceSend: !!meta.manual });
        } catch {}
      }
      return { ok: true, code: cand, emailed, reused: true, validFrom, validUntil };
    }
    // Belongs to someone else -- try the next derived candidate.
  }
  if (!code) code = "BDAY" + Date.now().toString(36).toUpperCase().slice(-5);

  try {
    await rewards.setJSON("reward:" + code, {
      code, type: "free-visit", kind: "birthday", source: "birthday",
      childName: ((rec.first || "") + " " + (rec.last || "")).trim(),
      loyaltyCode: loyaltyCode || rec.code || null,
      dob: rec.dob || "",
      validFrom, expiry: validUntil, used: false,
      issuedAt: new Date().toISOString(),
      // Set when staff issued this by hand. The daily cron treats a manual code as
      // "this birthday is already handled" and stays out of the way entirely —
      // no second code, no day-of reminder.
      manual: !!meta.manual,
    });
  } catch { return { ok: false, error: "Couldn't save the gift code. Try again." }; }

  // Mirror the code onto the loyalty card itself, so the booking page (and admin)
  // can surface "it's their birthday!" just by looking up the loyalty code.
  const lc = loyaltyCode || rec.code || null;
  if (lc) {
    try {
      const loyalty = getStore("loyalty");
      const card = await loyalty.get("card:" + lc, { type: "json" });
      if (card) {
        card.activeBirthdayCode = code;
        card.activeBirthdayExpiry = validUntil;
        await loyalty.setJSON("card:" + lc, card);
      }
    } catch {}
  }

  // The day-of pass sends its own "it's today" email. Before this flag it also
  // got the week-ahead email from in here, so one code arrived twice.
  let emailed = false;
  if (meta.sendEmail !== false) {
    try { emailed = await sendBirthdayEmail(rec, code, isRange ? { validFrom, validUntil } : when, { forceSend: !!meta.manual }); } catch {}
  }
  return { ok: true, code, emailed, validFrom, validUntil };
}

export async function sendBirthdayEmail(rec, code, when, opts = {}) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !rec.email) return false;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const name = esc(rec.first || "your little one");
  const isRange = when && typeof when === "object" && when.validFrom !== when.validUntil;
  const singleDay = isRange ? when.validFrom : when;
  const pretty = prettyDate(singleDay);
  const turning = ageOn(rec.dob, singleDay);
  const validityLine = isRange
    ? `Valid all birthday week: <b>${esc(prettyDate(when.validFrom))}</b> – <b>${esc(prettyDate(when.validUntil))}</b> 🎈`
    : `Good on ${esc(pretty)} 🎈`;
  const bodyLine = isRange
    ? `Enter it in the <b>Have a code?</b> box when you book Open Play online. One free child admission, any open day that week.`
    : `Enter it in the <b>Have a code?</b> box when you book Open Play online. Good on ${esc(pretty)} for one child admission.`;

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;background:#fdf1ec;padding:26px 14px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#c97d76,#e0a89f);padding:26px 24px;text-align:center">
      <div style="font-size:40px;line-height:1">🎂🎈🎉</div>
      <h1 style="margin:8px 0 0;color:#ffffff;font-size:26px;font-weight:800;letter-spacing:.3px">Happy Birthday, ${name}!</h1>
      ${turning > 0 && turning < 19 ? `<p style="margin:6px 0 0;color:#ffeae6;font-size:15px;font-weight:700">Turning ${turning}! 🌟</p>` : ""}
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 14px;font-size:15px;color:#2a2622;line-height:1.6">
        We can't wait to celebrate with you! Here's a little gift from all of us at ${esc(studio)} —
        <b>one FREE open-play admission</b> for ${name}, good all birthday week.
      </p>
      <div style="background:#ecf1e8;border:2px dashed #7ba676;border-radius:16px;padding:18px;text-align:center;margin:18px 0">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#4d7848;font-weight:800">Your birthday gift code</div>
        <div style="font-size:30px;font-weight:800;letter-spacing:3px;color:#2a2622;margin:8px 0">${esc(code)}</div>
        <div style="font-size:13px;color:#4d7848;font-weight:700">${validityLine}</div>
      </div>
      <p style="margin:0 0 14px;font-size:14px;color:#5c6470;line-height:1.6">
        ${bodyLine}
      </p>
      <div style="text-align:center;margin:22px 0 6px">
        <a href="https://littlehavenplay.com/book.html" style="display:inline-block;background:#c97d76;color:#ffffff;text-decoration:none;font-weight:800;font-size:16px;padding:14px 34px;border-radius:40px">Book the birthday visit →</a>
      </div>
      <p style="margin:16px 0 0;font-size:13px;color:#aea298;text-align:center">See you soon — ${esc(studio)} 💛</p>
    </div>
  </div>
</div>`;

  // Routed through resendEmail so this send carries an Idempotency-Key.
  // It used to POST to Resend directly, which meant a retry -- or a second
  // cron run -- delivered the same birthday email again.
  return await resendEmail({
      from: fromHeader(from, studio), to: [rec.email], bcc: bcc ? [bcc] : undefined,
      subject: `🎂 Happy Birthday${rec.first ? " " + rec.first : ""}! A free visit is waiting`, html: html + SIGNATURE_HTML,
    }, opts.forceSend
         // Staff pressing "Send birthday code" means send it, even if the same
         // code went out earlier today. Only the automatic run uses the stable
         // key that collapses accidental repeats.
         ? {}
         : { idempotencyKey: `bday-advance:${code}:${String(rec.email).toLowerCase()}` });
}

export async function sendBirthdayDayOfEmail(rec, code, when, validUntil) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !rec.email) return false;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const name = esc(rec.first || "your little one");
  // When the birthday lands on the last day of its own week (a Saturday) there
  // is no "rest of the week" left. Saying "good all this week" on that day is
  // what sent a family to the booking page to be told the code had expired.
  const lastDay = !!validUntil && String(when).slice(0, 10) >= String(validUntil).slice(0, 10);
  const throughLine = lastDay
    ? `Today is the last day to use it 🎈`
    : (validUntil ? `Good all week — through ${esc(prettyDate(validUntil))} 🎈` : `Good all birthday week 🎈`);

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;background:#fdf1ec;padding:26px 14px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#c97d76,#e0a89f);padding:26px 24px;text-align:center">
      <div style="font-size:40px;line-height:1">🎉🎂🎉</div>
      <h1 style="margin:8px 0 0;color:#ffffff;font-size:26px;font-weight:800;letter-spacing:.3px">It's ${name}'s birthday today!</h1>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 14px;font-size:15px;color:#2a2622;line-height:1.6">
        Happy birthday! 🎂 ${lastDay
          ? `Your free open-play admission is good <b>today</b> — the last day of the birthday week:`
          : `Your free open-play admission is good <b>all this week</b>, so come play any open day that works for you:`}
      </p>
      <div style="background:#ecf1e8;border:2px dashed #7ba676;border-radius:16px;padding:18px;text-align:center;margin:18px 0">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#4d7848;font-weight:800">Your birthday gift code</div>
        <div style="font-size:30px;font-weight:800;letter-spacing:3px;color:#2a2622;margin:8px 0">${esc(code)}</div>
        <div style="font-size:13px;color:#4d7848;font-weight:700">${throughLine}</div>
      </div>
      <p style="margin:0 0 14px;font-size:14px;color:#5c6470;line-height:1.6">
        Enter it in the <b>Have a code?</b> box when you book Open Play online.
      </p>
      <div style="text-align:center;margin:22px 0 6px">
        <a href="https://littlehavenplay.com/book.html" style="display:inline-block;background:#c97d76;color:#ffffff;text-decoration:none;font-weight:800;font-size:16px;padding:14px 34px;border-radius:40px">Book an open-play visit →</a>
      </div>
      <p style="margin:16px 0 0;font-size:13px;color:#aea298;text-align:center">Happy birthday from all of us — ${esc(studio)} 💛</p>
    </div>
  </div>
</div>`;

  // Routed through resendEmail so this send carries an Idempotency-Key.
  // It used to POST to Resend directly, which meant a retry -- or a second
  // cron run -- delivered the same birthday email again.
  return await resendEmail({
      from: fromHeader(from, studio), to: [rec.email], bcc: bcc ? [bcc] : undefined,
      subject: `🎉 Happy Birthday${rec.first ? " " + rec.first : ""}! Your free visit is good all week`, html: html + SIGNATURE_HTML,
    }, { idempotencyKey: `bday-dayof:${code}:${String(rec.email).toLowerCase()}` });
}

export function prettyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${months[m - 1]} ${d}, ${y}`;
}
export function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
