// POST /api/loyalty  — staff/admin loyalty punch card tool + public reward check.
//   { key, action:"punch",  childFirst, childLast, phone, email? }
//   { key, action:"lookup", code | childFirst+childLast+phone }
//   { key, action:"adjust", code | childFirst+childLast+phone, editFirst?, editLast?, dob?, setPunches? }
//     — the one edit endpoint: rename, set/correct a birth date, and/or set punches, any combination
//   { key, action:"list" }
//   { action:"reward-check", rewardCode }          (public — booking page)
//   { action:"code-check", code }                  (public — booking page, auto-fill by loyalty code)
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import {
  PUNCHES_FOR_REWARD, resolveCard, addPunch, cleanName, last4, normalizeCode,
  isLegacyPassCode, sendFamilyPunch, sendMilitaryVerifiedEmail,
} from "./lib-loyalty.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = (b.action || "").toString();

  if (action === "reward-check") {
    const rewards = getStore("rewards");
    const rc = normalizeCode(b.rewardCode);
    if (!rc) return json({ valid: false });
    let r = null;
    try { r = await rewards.get("reward:" + rc, { type: "json" }); } catch { r = null; }
    if (!r) return json({ valid: false, reason: "not_found" });
    if (r.used) return json({ valid: false, reason: "used" });
    // Validate against the play date the customer picked, not today's real date —
    // a code good for a future window (e.g. a birthday code valid Aug 16-23) must
    // check out fine when booked in advance for a date inside that window.
    const playDate = (b.date || "").toString().trim() || todayPacific();
    if (r.validFrom && playDate < r.validFrom) return json({ valid: false, reason: "not_yet", validFrom: r.validFrom });
    if (r.expiry && playDate > r.expiry) return json({ valid: false, reason: "expired" });
    return json({ valid: true, code: rc, childName: r.childName || "", expiry: r.expiry,
      type: "free-visit", kind: r.kind || "visit", loyaltyCode: r.loyaltyCode || null });
  }

  // Public, unauthenticated: lets the booking page auto-fill a child's name (and
  // flag an active birthday gift) from a loyalty code, without exposing anything
  // sensitive like a full birth date or contact info to whoever holds the code.
  if (action === "code-check") {
    const code = normalizeCode(b.code);
    if (!code) return json({ found: false });
    const loyaltyPub = getStore("loyalty");
    let rec = null; try { rec = await loyaltyPub.get("card:" + code, { type: "json" }); } catch { rec = null; }
    if (!rec) return json({ found: false });
    let birthday = null;
    if (rec.activeBirthdayCode && rec.activeBirthdayExpiry) {
      const today = todayPacific();
      if (today <= rec.activeBirthdayExpiry) {
        let r = null; try { r = await getStore("rewards").get("reward:" + rec.activeBirthdayCode, { type: "json" }); } catch {}
        if (r && !r.used) birthday = { code: rec.activeBirthdayCode, expiry: rec.activeBirthdayExpiry };
      }
    }
    return json({ found: true, code, childName: rec.childName || "", hasDob: !!rec.dob, birthday, militaryVerified: !!rec.militaryVerified, punches: rec.punches || 0, needed: PUNCHES_FOR_REWARD });
  }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const loyalty = getStore("loyalty");

  if (action === "list") {
    const out = [];
    try {
      const keys = await listAllKeys(loyalty, { prefix: "card:" });
      for (const k of keys) {
        let rec = null;
        try { rec = await loyalty.get(k, { type: "json" }); } catch { rec = null; }
        if (!rec) continue;
        out.push({ code: rec.code, childName: rec.childName || "", email: rec.buyerEmail || "",
          parentName: rec.parentName || "", phone4: rec.phone4 || "", phone: rec.phone || "", dob: rec.dob || "",
          punches: rec.punches || 0, needed: PUNCHES_FOR_REWARD,
          totalVisits: rec.totalVisits || 0, rewardsEarned: rec.rewardsEarned || 0,
          waiverSigned: rec.waiverSigned || "", waiverExpiry: rec.waiverExpiry || "",
          waiverAdults: Array.isArray(rec.waiverAdults) ? rec.waiverAdults : [],
          militaryVerified: !!rec.militaryVerified,
          lastVisit: rec.lastVisit ? rec.lastVisit.slice(0, 10) : "",
          createdAt: rec.createdAt ? rec.createdAt.slice(0, 10) : "" });
      }
    } catch { return json({ error: "Couldn't load the list." }, 502); }
    const lastName = n => { const p = (n || "").trim().split(/\s+/); return (p[p.length - 1] || "").toLowerCase(); };
    out.sort((a, c) => lastName(a.childName).localeCompare(lastName(c.childName)) || (a.childName || "").toLowerCase().localeCompare((c.childName || "").toLowerCase()));
    return json({ ok: true, count: out.length, customers: out });
  }

  // Find every card on file for a phone number (the family) — used by the walk-in
  // "find or create" panel so staff can pull a returning family up by phone.
  if (action === "by-phone") {
    const p4 = last4(b.phone);
    if (!p4) return json({ error: "Enter at least the last 4 digits of the phone." }, 400);
    const out = [];
    try {
      const keys = await listAllKeys(loyalty, { prefix: "card:" });
      for (const k of keys) {
        let rec = null; try { rec = await loyalty.get(k, { type: "json" }); } catch { rec = null; }
        if (!rec || rec.phone4 !== p4) continue;
        out.push({ code: rec.code, childName: rec.childName || "", dob: rec.dob || "",
          punches: rec.punches || 0, needed: PUNCHES_FOR_REWARD, rewardsEarned: rec.rewardsEarned || 0,
          email: rec.buyerEmail || "", militaryVerified: !!rec.militaryVerified,
          waiverSigned: rec.waiverSigned || "", waiverExpiry: rec.waiverExpiry || "",
          waiverAdults: Array.isArray(rec.waiverAdults) ? rec.waiverAdults.map(a => a.name || a).filter(Boolean) : [],
          lastVisit: rec.lastVisit ? rec.lastVisit.slice(0, 10) : "" });
      }
    } catch { return json({ error: "Couldn't search right now." }, 502); }
    out.sort((a, c) => (a.childName || "").localeCompare(c.childName || ""));
    return json({ ok: true, count: out.length, cards: out });
  }

  // Explicit, staff-triggered send — covers EVERY currently-verified sibling under
  // one family in a single email, with each child's own loyalty code included.
  // Call this once, after verifying all of a family's kids, not per child — see
  // the note in action:"adjust" for why per-toggle auto-sending used to split one
  // family across two separate emails.
  if (action === "send-military-email") {
    const code = normalizeCode(b.code);
    let anchor = null;
    if (code) { try { anchor = await loyalty.get("card:" + code, { type: "json" }); } catch {} }
    const phone4 = (b.phone4 || (anchor && anchor.phone4) || "").toString();
    if (!phone4) return json({ error: "Missing family phone." }, 400);

    const keys = await listAllKeys(loyalty, { prefix: "card:" });
    const verified = [];
    let toEmail = "";
    for (const k of keys) {
      let c = null; try { c = await loyalty.get(k, { type: "json" }); } catch {}
      if (!c || c.phone4 !== phone4) continue;
      if (c.buyerEmail && !toEmail) toEmail = c.buyerEmail;
      if (c.militaryVerified) verified.push({ code: c.code, childName: c.childName });
    }
    if (!verified.length) return json({ error: "No military-verified card found for this family." }, 404);
    if (!toEmail) return json({ error: "No email on file for this family — can't send." }, 400);

    const sent = await sendMilitaryVerifiedEmail(toEmail, verified);
    if (!sent) return json({ error: "Couldn't send the email. Try again." }, 502);
    return json({ ok: true, sentTo: toEmail, children: verified.map(v => v.childName), count: verified.length });
  }

  if (action === "visit-history") {
    const code = normalizeCode(b.code);
    if (!code) return json({ error: "Missing code." }, 400);
    let rec = null; try { rec = await loyalty.get("card:" + code, { type: "json" }); } catch {}
    if (!rec) return json({ error: "Card not found." }, 404);
    const visits = Array.isArray(rec.visits) ? rec.visits : [];
    return json({ ok: true, code, childName: rec.childName || "", visits });
  }

  if (action === "lookup") {
    const direct = normalizeCode(b.code);
    if (direct && await isLegacyPassCode(direct)) {
      return json({ ok: true, legacy: true, code: direct,
        message: "This is a pre-paid LEGACY punch card — not part of the loyalty program, so it doesn't earn loyalty punches." });
    }
    let code = direct, rec = null;
    if (direct) { try { rec = await loyalty.get("card:" + direct, { type: "json" }); } catch { rec = null; } }
    // Fall back to name+phone search if a typed code doesn't exist (e.g. staff guessed the
    // code wrong — a sibling/collision may have pushed this child's real card to a longer code).
    if (!rec) {
      const first = (b.childFirst || "").toString().trim(), last = (b.childLast || "").toString().trim(), p4 = last4(b.phone);
      if (first && last && p4) {
        const r = await resolveCard(loyalty, first, last, p4, true);
        if (r.rec) { code = r.code; rec = r.rec; }
      } else if (!direct) {
        return json({ error: "Enter a code, or the child's first & last name + phone." }, 400);
      }
    }
    if (!rec) return json({ ok: true, found: false, code: code || "" });
    return json({ ok: true, found: true, code, childName: rec.childName || "", dob: rec.dob || "", phone4: rec.phone4 || "",
      punches: rec.punches || 0, needed: PUNCHES_FOR_REWARD, rewardsEarned: rec.rewardsEarned || 0,
      lastRewardCode: rec.lastRewardCode || null, createdAt: rec.createdAt, militaryVerified: !!rec.militaryVerified });
  }

  // "adjust" is the one unified edit endpoint: given a code (or name+phone fallback),
  // it can rename the child, set/correct their birth date, and/or set their punch
  // count — any combination, in a single save. Replaces the old separate setdob action.
  if (action === "adjust") {
    const direct = normalizeCode(b.code);
    if (direct && await isLegacyPassCode(direct)) {
      return json({ error: "That's a pre-paid legacy punch card — it can't be adjusted here." }, 409);
    }
    let code = direct, rec = null;
    if (direct) { try { rec = await loyalty.get("card:" + direct, { type: "json" }); } catch { rec = null; } }
    if (!rec) {
      const first = (b.childFirst || "").toString().trim(), last = (b.childLast || "").toString().trim(), p4 = last4(b.phone);
      if (first && last && p4) {
        // Falls back to the child's real card (by name+phone) if a typed code was wrong/guessed,
        // instead of silently forking a duplicate card at the mistyped code.
        const r = await resolveCard(loyalty, first, last, p4, false);
        code = r.code; rec = r.rec;
      } else if (!direct) {
        return json({ error: "Enter the code (or child name + phone) to adjust." }, 400);
      }
    }

    const hasSetPunches = b.setPunches !== undefined && b.setPunches !== null && b.setPunches !== "";
    let setP = null;
    if (hasSetPunches) {
      setP = parseInt(b.setPunches, 10);
      if (!Number.isFinite(setP) || setP < 0 || setP > 7) return json({ error: "Set punches to a number 0-7." }, 400);
    }
    const renameFirst = (b.editFirst || "").toString().trim(), renameLast = (b.editLast || "").toString().trim();
    const wantsRename = renameFirst || renameLast;
    const dob = (b.dob || "").toString().trim();
    if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return json({ error: "Enter the birth date as YYYY-MM-DD." }, 400);

    if (!rec) {
      rec = { code, childName: cleanName(b.childFirst, b.childLast) || (b.childName || ""), phone4: last4(b.phone),
        punches: 0, rewardsEarned: 0, totalVisits: 0, createdAt: new Date().toISOString(), history: [],
        buyerEmail: (b.email || "").toString().trim() };
    }
    rec.history = Array.isArray(rec.history) ? rec.history : [];
    if (wantsRename) {
      const before = rec.childName;
      rec.childName = cleanName(renameFirst || (before || "").split(" ")[0], renameLast || (before || "").split(" ").slice(1).join(" "));
      rec.history.push({ at: new Date().toISOString(), action: "renamed", from: before, to: rec.childName });
    }
    if (dob) { rec.dob = dob; rec.history.push({ at: new Date().toISOString(), action: "dob-set", to: dob }); }
    if (b.email !== undefined) {
      const newEmail = (b.email || "").toString().slice(0, 160).trim();
      if (newEmail && newEmail !== (rec.buyerEmail || "")) {
        rec.history.push({ at: new Date().toISOString(), action: "email-changed", from: rec.buyerEmail || "", to: newEmail });
        rec.buyerEmail = newEmail;   // future reward + reminder emails go here (e.g. a babysitter's address)
      } else if (!newEmail && rec.buyerEmail) {
        rec.history.push({ at: new Date().toISOString(), action: "email-cleared", from: rec.buyerEmail });
        rec.buyerEmail = "";
      }
    }
    if (hasSetPunches) { rec.punches = setP; rec.history.push({ at: new Date().toISOString(), action: "adjusted", to: setP }); }
    if (b.militaryVerified !== undefined) {
      const mv = !!b.militaryVerified;
      const wasVerified = !!rec.militaryVerified;
      if (mv !== wasVerified) rec.history.push({ at: new Date().toISOString(), action: mv ? "military-verified" : "military-unverified" });
      rec.militaryVerified = mv;
      // No email sent automatically here anymore — see action:"send-military-email".
      // Verifying multiple siblings one at a time used to race: an email sent for
      // the first child couldn't know about the second one verified a minute
      // later, so the family got two separate emails instead of one. Staff now
      // verify everyone in the family first, then send one explicit email that
      // covers all of them.
    }
    // Re-linking a card to a different family, e.g. a child was mistakenly grouped
    // with someone else's kids because a booking shared one phone number (a parent
    // brought a friend's child along, or a data-entry mixup). The CODE never changes
    // — that's the permanent identity — only which phone4 groups it into a family.
    // Everything else on the card (punches, waiver, birthday, military status,
    // history) is untouched.
    if (b.editPhone4 !== undefined) {
      const newP4 = (b.editPhone4 || "").toString().replace(/\D/g, "").slice(-4);
      if (newP4 && newP4.length === 4 && newP4 !== rec.phone4) {
        rec.history.push({ at: new Date().toISOString(), action: "family-relinked", from: rec.phone4 || null, to: newP4 });
        rec.phone4 = newP4;
      }
    }

    try { await loyalty.setJSON("card:" + code, rec); } catch { return json({ error: "Couldn't update the card." }, 502); }
    return json({ ok: true, adjusted: true, code, childName: rec.childName, dob: rec.dob || "", punches: rec.punches, needed: PUNCHES_FOR_REWARD, militaryVerified: !!rec.militaryVerified, phone4: rec.phone4 || "", email: rec.buyerEmail || "" });
  }

  if (action === "punch") {
    const direct = normalizeCode(b.code);
    const waiverSigned = (b.waiverSigned || "").toString().trim();
    const adultNames = Array.isArray(b.adultNames) ? b.adultNames : [];
    if (direct) {
      if (await isLegacyPassCode(direct)) return json({ error: "That's a legacy prepaid card — don't punch it here." }, 409);
      let exists = null; try { exists = await loyalty.get("card:" + direct, { type: "json" }); } catch {}
      if (!exists) return json({ error: "No loyalty card found for that code." }, 404);
      const r = await addPunch(loyalty, { code: direct, waiverSigned, adultNames, visitMeta: { date: todayPacific(), source: "manual" } });
      if (r.error) return json({ error: "Couldn't save the punch. Try again." }, 502);
      return json({ ok: true, ...r,
        message: r.rewardIssued
          ? `${r.childName} earned a FREE visit! Reward code ${r.rewardCode} was emailed (expires ${r.rewardExpiry}).`
          : `Punched! ${r.childName} (${r.code}) now has ${r.punches}/${r.needed} visits toward a free one.` });
    }
    const first = (b.childFirst || "").toString().trim();
    const last  = (b.childLast || "").toString().trim();
    const phone4 = last4(b.phone);
    if (!first || !last) return json({ error: "Enter the child's first and last name." }, 400);
    if (!phone4)        return json({ error: "Enter the parent's phone (at least the last 4 digits)." }, 400);
    const email = (b.email || "").toString().slice(0, 160).trim();
    const militaryVerified = !!b.militaryVerified;
    const dob = (b.dob || "").toString().trim();
    const r = await addPunch(loyalty, { first, last, phone4, email, waiverSigned, adultNames, militaryVerified, dob, visitMeta: { date: todayPacific(), source: "manual" } });
    if (r.error) return json({ error: r.message || "Couldn't save the punch. Try again." }, 502);
    return json({ ok: true, ...r,
      message: r.rewardIssued
        ? `${r.childName} earned a FREE visit! Reward code ${r.rewardCode} was emailed (expires ${r.rewardExpiry}).`
        : `Punched! ${r.childName} (${r.code}) now has ${r.punches}/${r.needed} visits toward a free one.` });
  }

  if (action === "delete") {
    const direct = normalizeCode(b.code);
    if (direct && await isLegacyPassCode(direct)) {
      return json({ error: "That's a pre-paid legacy punch card — it can't be deleted here." }, 409);
    }
    let code = direct, rec = null;
    if (direct) { try { rec = await loyalty.get("card:" + direct, { type: "json" }); } catch { rec = null; } }
    else {
      const first = (b.childFirst || "").toString().trim(), last = (b.childLast || "").toString().trim(), p4 = last4(b.phone);
      if (!first || !last || !p4) return json({ error: "Enter the code (or child name + phone) to delete." }, 400);
      const r = await resolveCard(loyalty, first, last, p4, false);
      code = r.code; rec = r.rec;
    }
    if (!code || !rec) return json({ error: "No loyalty card found for that code." }, 404);
    const name = rec.childName || "";
    try { await loyalty.delete("card:" + code); } catch { return json({ error: "Couldn't delete the card. Try again." }, 502); }
    return json({ ok: true, deleted: true, code, childName: name });
  }

  if (action === "family-punch") {
    const email = (b.email || "").toString().slice(0, 160).trim();
    const phone4 = last4(b.phone);
    const waiverSigned = (b.waiverSigned || "").toString().trim();
    const adultNames = Array.isArray(b.adultNames) ? b.adultNames : [];
    if (!phone4) return json({ error: "Enter the parent's phone (at least the last 4 digits)." }, 400);
    const kids = (Array.isArray(b.children) ? b.children : [])
      .map(c => ({ first: (c && c.first || "").toString().trim(), last: (c && c.last || "").toString().trim(), dob: (c && c.dob || "").toString().trim() }))
      .filter(c => c.first && c.last)
      .slice(0, 4);
    if (!kids.length) return json({ error: "Enter at least one child's first and last name." }, 400);
    const militaryVerified = !!b.militaryVerified;
    const results = [];
    for (const c of kids) {
      const r = await addPunch(loyalty, { first: c.first, last: c.last, phone4, email, suppressEmail: true, waiverSigned, adultNames, militaryVerified, dob: c.dob, visitMeta: { date: todayPacific(), source: "manual" } });
      if (!r.error) results.push(r);
    }
    if (!results.length) return json({ error: "Couldn't save the punches. Try again." }, 502);
    if (email) { try { await sendFamilyPunch(email, results); } catch {} }
    const rewardCount = results.filter(r => r.rewardIssued).length;
    return json({ ok: true, results, count: results.length, rewardCount,
      message: `Punched ${results.length} child${results.length === 1 ? "" : "ren"}${email ? " — one combined email sent" : ""}${rewardCount ? ` · ${rewardCount} free visit${rewardCount === 1 ? "" : "s"} earned!` : ""}.` });
  }

  // Set a waiver "signed" date for a child (or the whole family by phone). Expiry = signed + 365 days.
  // set-waiver now handles two independent things, either or both in one call:
  //   b.signed        → the child's own waiver date (existing behavior)
  //   b.adults        → the FULL list of adults/supervisors on file for this family,
  //                      each with their own signed date (365-day expiry each) — since
  //                      different adults often sign on different visits.
  if (action === "set-waiver") {
    const hasSigned = !!(b.signed || "").toString().trim();
    const hasAdults = Array.isArray(b.adults);
    if (!hasSigned && !hasAdults) return json({ error: "Nothing to save." }, 400);

    let signed = null, expiry = null;
    if (hasSigned) {
      signed = (b.signed || "").toString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(signed)) return json({ error: "Enter a valid waiver date (YYYY-MM-DD)." }, 400);
      const exp = new Date(signed + "T12:00:00"); exp.setDate(exp.getDate() + 365);
      expiry = exp.toISOString().slice(0, 10);
    }

    let adults = null;
    if (hasAdults) {
      adults = b.adults.slice(0, 20).map(a => {
        const name = (a && a.name || "").toString().slice(0, 80).trim();
        const sd = (a && a.signedDate || "").toString().slice(0, 10);
        const validDate = /^\d{4}-\d{2}-\d{2}$/.test(sd) ? sd : "";
        let adultExpiry = "";
        if (validDate) { const e = new Date(validDate + "T12:00:00"); e.setDate(e.getDate() + 365); adultExpiry = e.toISOString().slice(0, 10); }
        return { name, signedDate: validDate, expiry: adultExpiry };
      }).filter(a => a.name);
    }

    const applyFamily = !!b.family;
    const code = normalizeCode(b.code);
    let targets = [];
    if (applyFamily && b.phone4) {
      try {
        const keys = await listAllKeys(loyalty, { prefix: "card:" });
        for (const k of keys) { let r = null; try { r = await loyalty.get(k, { type: "json" }); } catch {} if (r && r.phone4 === (b.phone4 || "").toString()) targets.push(r); }
      } catch {}
    } else if (code) {
      let r = null; try { r = await loyalty.get("card:" + code, { type: "json" }); } catch {}
      if (r) targets.push(r);
    }
    if (!targets.length) return json({ error: "No matching loyalty card found." }, 404);
    for (const r of targets) {
      if (hasSigned) { r.waiverSigned = signed; r.waiverExpiry = expiry; }
      if (hasAdults) { r.waiverAdults = adults; }
      try { await loyalty.setJSON("card:" + r.code, r); } catch {}
    }
    return json({ ok: true, signed, expiry, adults, count: targets.length });
  }

  return json({ error: "Unknown action." }, 400);
};

function todayPacific() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/loyalty" };
