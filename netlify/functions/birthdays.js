// POST /api/birthdays  (admin key or staff PIN)
//   { key, action:"list", month:"09" | "all" }  → children with birthdays that month + parent contact
//   { key, action:"send", code }                 → generate + email that child's birthday gift code now
//   { key, action:"send-custom", first, last, email, validFrom, validUntil, loyaltyCode? }
//                                                 → manual version for a birthday that falls on a closed
//                                                   day: a custom date-range 100%-free-admission code for
//                                                   a named child. Works even with no existing loyalty card.
//   { key, action:"remove", code }                → forget a child's birthday (keeps the loyalty card + punch history)
// To set/edit a birth date, use POST /api/loyalty { action:"adjust", code, dob } instead —
// that's the one place all loyalty-card edits (name, dob, punches) now live.
//
// Source of truth: the loyalty card itself (card.dob). Birthday gift codes reuse the
// free-visit reward mechanism (one free child admission). They are valid on the
// birthday ONLY (validFrom === expiry === the birthday) and single-use.
import { getStore } from "@netlify/blobs";
import { nextOccurrence, ageOn, issueBirthdayCode, birthdayWeek } from "./lib-birthday.js";
import { normalizeCode } from "./lib-loyalty.js";

// Whole years completed as of today, Pacific.
function currentAge(dob) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || "")) return null;
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))
    .toISOString().slice(0, 10);
  let age = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
  if (today.slice(5) < dob.slice(5)) age -= 1;   // birthday hasn't come round yet
  return age < 0 || age > 120 ? null : age;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const loyalty = getStore("loyalty");
  const action = (b.action || "list").toString();

  if (action === "list") {
    const monthRaw = (b.month || "").toString();
    const all = monthRaw === "all";
    const month = monthRaw.padStart(2, "0");
    if (!all && !/^(0[1-9]|1[0-2])$/.test(month)) return json({ error: "Pick a month." }, 400);
    let keys = [];
    try { const r = await loyalty.list({ prefix: "card:" }); keys = (r.blobs || []).map(x => x.key); } catch {}
    const rows = [];
    for (const k of keys) {
      let rec = null; try { rec = await loyalty.get(k, { type: "json" }); } catch {}
      if (!rec || !rec.dob) continue;
      const cmm = rec.dob.slice(5, 7), cdd = rec.dob.slice(8, 10);
      if (!all && cmm !== month) continue;
      const parts = (rec.childName || "").trim().split(/\s+/);
      rows.push({
        code: rec.code || k.slice(5), first: parts[0] || "", last: parts.slice(1).join(" ") || "",
        dob: rec.dob, month: cmm, day: cdd,
        // "Turning" is the age at the NEXT birthday, so once this year's has
        // passed it jumps to next year's number — which reads as wrong when you
        // are looking at a child who just had their birthday. Send the current
        // age and the raw DOB too so the table can show something unambiguous.
        turning: ageOn(rec.dob, nextOccurrence(rec.dob)),
        ageNow: currentAge(rec.dob),
        birthdayUsedYear: rec.birthdayUsedYear || null,
        email: rec.buyerEmail || "", phone: rec.phone || "",
        lastSentYear: rec.lastSentYear || null, lastCode: rec.lastCode || "",
      });
    }
    // Sort by month+day together (not day alone) — otherwise "all months" mode would
    // group every 1st-of-the-month before every 2nd, regardless of which month.
    rows.sort((a, c) => ((a.month || "") + (a.day || "")).localeCompare((c.month || "") + (c.day || "")));
    return json({ ok: true, month: all ? "all" : month, rows, count: rows.length });
  }

  if (action === "remove") {
    const code = normalizeCode(b.code);
    if (!code) return json({ error: "Missing loyalty code." }, 400);
    let card = null; try { card = await loyalty.get("card:" + code, { type: "json" }); } catch {}
    if (!card) return json({ error: "That child's record wasn't found." }, 404);
    // Only forgets the birthday — the loyalty card and punch history stay intact.
    delete card.dob; delete card.lastSentYear; delete card.lastCode; delete card.lastSentAt;
    delete card.dayOfSentYear; delete card.activeBirthdayCode; delete card.activeBirthdayExpiry;
    try { await loyalty.setJSON("card:" + code, card); } catch {}
    return json({ ok: true });
  }

  if (action === "send") {
    const code = normalizeCode(b.code);
    if (!code) return json({ error: "Missing loyalty code." }, 400);
    let card = null; try { card = await loyalty.get("card:" + code, { type: "json" }); } catch {}
    if (!card) return json({ error: "That child's record wasn't found." }, 404);
    if (!card.dob) return json({ error: "No birth date on file for this card yet." }, 400);
    if (!card.buyerEmail) return json({ error: `No email on file for ${card.childName || "this child"} — text them the code instead.` }, 400);

    const parts = (card.childName || "").trim().split(/\s+/);
    const first = parts[0] || "", last = parts.slice(1).join(" ") || "";
    const when = nextOccurrence(card.dob);
    const week = birthdayWeek(when);
    const result = await issueBirthdayCode({ first, last, email: card.buyerEmail, dob: card.dob, code }, week, code, { manual: true });
    if (!result.ok) return json({ error: result.error }, 502);

    // issueBirthdayCode writes activeBirthdayCode onto the card, so re-read it here.
    // Writing back the copy we loaded before that call would wipe those fields and
    // the "it's their birthday!" badge would quietly vanish from the booking page.
    let fresh = card;
    try { fresh = (await loyalty.get("card:" + code, { type: "json" })) || card; } catch {}
    fresh.lastSentYear = when.slice(0, 4);
    fresh.lastCode = result.code;
    fresh.lastSentAt = new Date().toISOString();
    // Staff sent this by hand, so suppress the automatic day-of reminder for this
    // birthday — the family has already been told.
    fresh.dayOfSentYear = when.slice(0, 4);
    fresh.manualIssuedAt = new Date().toISOString();
    try { await loyalty.setJSON("card:" + code, fresh); } catch {}

    return json({ ok: true, code: result.code, when, emailed: result.emailed,
      message: `Birthday gift ${result.code} for ${first} — valid their birthday week (${result.validFrom} to ${result.validUntil}).` +
               (result.emailed ? " Emailed to the family." : " (Email didn't send — share the code directly.)") });
  }

  // Manual, staff-triggered version for when a birthday falls on a closed day
  // (e.g. Mondays) — same 100%-free-admission mechanism as the automatic
  // birthday emails, but with a custom date window instead of a single day,
  // and it works even for a child who has never visited before: it only needs
  // a name to match at checkout, so no existing loyalty card is required. If
  // the family already has one and you know the code, link it so "it's their
  // birthday!" shows up on the card too — otherwise just leave that blank and
  // a card gets created automatically the same way any first free visit does.
  if (action === "send-custom") {
    const first = (b.first || "").toString().trim().slice(0, 60);
    const last = (b.last || "").toString().trim().slice(0, 60);
    const email = (b.email || "").toString().trim().slice(0, 160);
    const validFrom = (b.validFrom || "").toString().trim();
    const validUntil = (b.validUntil || "").toString().trim() || validFrom;
    const loyaltyCode = normalizeCode(b.loyaltyCode || "");
    if (!first || !last) return json({ error: "Enter the child's first and last name." }, 400);
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter a valid email to send the code to." }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) return json({ error: "Pick a valid start date." }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) return json({ error: "Pick a valid end date." }, 400);
    if (validUntil < validFrom) return json({ error: "The end date can't be before the start date." }, 400);

    let dob = "", cardRec = null;
    if (loyaltyCode) {
      try { cardRec = await loyalty.get("card:" + loyaltyCode, { type: "json" }); } catch {}
      if (cardRec) dob = cardRec.dob || "";
    }

    const result = await issueBirthdayCode({ first, last, email, dob }, { validFrom, validUntil }, loyaltyCode || null, { manual: true });
    if (!result.ok) return json({ error: result.error }, 502);

    // Record the issue on the loyalty card when one is linked. Without this the
    // daily cron has no idea a code already went out and mints a second one on the
    // child's birthday — which is exactly what used to happen. Re-read first so we
    // don't wipe the activeBirthdayCode that issueBirthdayCode just wrote.
    if (loyaltyCode) {
      try {
        const fresh = await loyalty.get("card:" + loyaltyCode, { type: "json" });
        if (fresh) {
          const yr = validFrom.slice(0, 4);
          fresh.lastSentYear = yr;
          fresh.lastCode = result.code;
          fresh.lastSentAt = new Date().toISOString();
          fresh.dayOfSentYear = yr;          // no automatic day-of reminder either
          fresh.manualIssuedAt = new Date().toISOString();
          await loyalty.setJSON("card:" + loyaltyCode, fresh);
        }
      } catch {}
    }

    return json({ ok: true, code: result.code, validFrom, validUntil, emailed: result.emailed,
      message: `Birthday gift ${result.code} for ${first} ${last} — good ${validFrom === validUntil ? "on " + validFrom : "between " + validFrom + " and " + validUntil}.` +
               (result.emailed ? " Emailed to the family." : " (Email didn't send — share the code directly.)") });
  }

  return json({ error: "Unknown action." }, 400);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/birthdays" };
