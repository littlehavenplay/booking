// POST /api/book
// Body: { date, slot, name, email, regular, sibling, sourceId }
//   sourceId = single-use card token from the Web Payments SDK (card.tokenize())
//
// Flow:
//   1. Validate input.
//   2. Compute children + amount SERVER-SIDE (never trust the browser's price).
//   3. Re-check capacity against Netlify Blobs; reject if it would exceed 15.
//   4. Charge the card via Square's CreatePayment API.
//   5. On success, record the booking and increment the slot's child count.

import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { SIGNATURE_HTML, sendOwnerAlert, resendEmail } from "./lib-email.js";
import {
  CAPACITY, pricesFor, SLOTS, SLOT_IDS, openPlayForDate, effectivePartyBlocks, hoursFor, slotCap, slotKey, arrivalStartMin, squareApiBase, SQUARE_VERSION, BOOKING_WINDOW_DAYS,
  PARTY_SLOT_IDS, ARRIVAL_TO_LEGACY, countHourChildren, hourMatesFor,
  STUDIO_NAME, POLICY_TITLE, POLICY_LINES, CLOSED_DATES, CLOSED_MESSAGE, ADDITIONAL_ADULT, isClosedWeekday, weekdayOf,
  additionalAdultsFor, additionalAdultCentsFor, GRIP_SOCK_CENTS, GRIP_SOCK_MAX,
} from "./lib-settings.js";
import { issueCode, sendWelcome, sendFamilyPunch, PUNCHES_FOR_REWARD, cleanName, last4 as loyaltyLast4, graduateLegacyCard } from "./lib-loyalty.js";
import { getActiveFamCode, logFamUse } from "./famcode.js";
// memberCoversDate was used below but NOT imported, so every Play Club member's
// checkout died with "memberCoversDate is not defined" — a hard 500 at payment.
// It cost a real customer a booking. The audit missed it because a syntax check
// and an import-resolve check both pass on a module that references an undefined
// global; only actually CALLING the code catches it. There is now a booking
// smoke test (test-booking-smoke.mjs) that posts a real booking through this
// handler, including a member booking, so this class of fault cannot ship again.
import { findMemberFor, recordMemberVisit, memberCoversDate } from "./lib-playclub.js";
import { FRIEND_DISCOUNT_CENTS, findFamilyByCode, familyStatus, normalizeRef, last4 as refLast4 } from "./lib-referral.js";
import { loadSeasonal, loadWeekly } from "./lib-hours.js";
import { getClosure, slotBlockedByClosure, getEventHold } from "./lib-closures.js";
import { getWeekdaySpecial } from "./lib-weekday.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid request body." }, 400); }

  const date = (body.date || "").trim();
  const slot = (body.slot || "").trim();
  const name = (body.name || "").toString().slice(0, 120).trim();
  const email = (body.email || "").toString().slice(0, 160).trim();
  const phone = (body.phone || "").toString().slice(0, 40).trim();
  // Each child: name (for their loyalty punch card), an optional loyalty code the family
  // already has (auto-fills/claims their existing card instead of guessing by name), which
  // admission type they're booked under (regular/sibling/infant — needed to know which price
  // a birthday reward should zero out), and an optional birthday gift code for that child.
  const childNames = Array.isArray(body.childNames)
    ? body.childNames.map(c => ({
        first: (c && c.first || "").toString().slice(0, 60).trim(),
        last:  (c && c.last  || "").toString().slice(0, 60).trim(),
        dob:   validDob((c && c.dob || "").toString().trim()),
        code:  (c && c.code || "").toString().trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20),
        admission: ["regular", "sibling", "infant"].includes((c && c.admission || "").toString()) ? c.admission : "",
        birthdayCode: (c && c.birthdayCode || "").toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20),
      }))
      .filter(c => c.first && c.last)
    : [];
  const regular = Math.max(0, parseInt(body.regular, 10) || 0);
  const sibling = Math.max(0, parseInt(body.sibling, 10) || 0);
  const infant  = Math.max(0, parseInt(body.infant, 10) || 0);
  const children = regular + sibling + infant;

  // Adults: the form sends the TRUE total adult headcount (totalAdults) so staff
  // can track physical occupancy. The number of PAID (extra) adults is decided by
  // the date-gated rule in settings — on/after 7/2 that's "2 adults included PER
  // Regular or Baby/Infant admission (not the Sibling add-on), $5 each beyond that."
  // Older clients may send additionalAdults directly as the already-extra count.
  const adultEligibleChildren = regular + infant;   // Sibling add-on carries no adults
  let totalAdults, additionalAdults;
  if (body.totalAdults !== undefined && body.totalAdults !== null && body.totalAdults !== "") {
    totalAdults = Math.max(1, parseInt(body.totalAdults, 10) || 1);
    additionalAdults = additionalAdultsFor(undefined, totalAdults, adultEligibleChildren, children);
  } else {
    additionalAdults = Math.max(0, parseInt(body.additionalAdults, 10) || 0);
    totalAdults = Math.max(1, children + additionalAdults);
  }
  const sourceId = (body.sourceId || "").toString();
  const giftCardCodes = Array.isArray(body.giftCards)
    ? [...new Set(body.giftCards.map(g => (g || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean))].slice(0, 2)
    : [];
  const passCodes = Array.isArray(body.visitPasses)
    ? [...new Set(body.visitPasses.map(g => (g || "").toString().trim().toUpperCase()).filter(Boolean))].slice(0, 2)
    : [];
  // Percent-off discount code (one-time, exclusive — see /api/discount). Gift cards are a form
  // of payment (like a credit card), not a "promo," so they're always allowed to combine with
  // anything. Store credit and legacy punch-card passes remain mutually exclusive with a discount.
  const discountCode = (body.discountCode || "").toString().trim().toUpperCase().replace(/\s+/g, "");
  const hasStoreCredit = !!(body.promoCode || "").toString().trim();
  if (discountCode && (hasStoreCredit || passCodes.length)) {
    return json({ error: "discount", message: "This discount code can't be combined with store credit or punch cards. Please use it on its own (gift cards are fine)." }, 409);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date." }, 400);
  // Past dates are never bookable; on today, a session is bookable only until its start time passes (Pacific).
  const _todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  if (date < _todayPT) return json({ error: "past", message: "That date has already passed. Please choose a current or future date." }, 400);
  if (date === _todayPT) {
    const _nowMinPT = (() => { const t = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour12: false }); const [h, m] = t.split(":").map(Number); return h * 60 + m; })();
    const _start = arrivalStartMin(slot);
    if (_start != null && _start <= _nowMinPT) return json({ error: "past", message: "That session's start time has already passed — please pick a later session." }, 400);
  }
  if (CLOSED_DATES.includes(date))      return json({ error: "closed", message: CLOSED_MESSAGE }, 409);
  const _seasonal = await loadSeasonal();
  const _weekly = await loadWeekly();
  if (isClosedWeekday(date, _seasonal, _weekly)) return json({ error: "closed", message: "We're closed that day. Please pick another day." }, 409);
  // Dynamic closure / early-close / late-open set from the admin/staff page.
  const _closure = await getClosure(date);
  if (_closure && _closure.type === "full")
    return json({ error: "closed", message: (_closure.note) || "We're closed that day." }, 409);

  // Event day: last admission = 2.5h before the event, and it OVERRIDES a manual early-close
  // (so an accidental early-close can't reject a slot the event actually allows).
  const _eventHold = await getEventHold(date);
  if (_eventHold) {
    const _st = arrivalStartMin(slot);
    if (_st != null && _st > _eventHold.cutoff)
      return json({ error: "closed", message: `Last admission is ${_eventHold.lastAdmitLabel} this day for a special event. Please choose an earlier time.` }, 409);
  } else if (slotBlockedByClosure(_closure, slot)) {
    return json({ error: "closed", message: (_closure && _closure.note) || "We're closed for that time." }, 409);
  }
  if (!SLOT_IDS.includes(slot))         return json({ error: "Invalid time slot." }, 400);
  // Open play can only be booked within the rolling window (default 2 weeks).
  const maxStr = new Date(Date.now() + BOOKING_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  if (date > maxStr)                    return json({ error: "window", message: `Open play can only be booked up to ${BOOKING_WINDOW_DAYS} days ahead.` }, 400);
  // Parties take precedence — only allow sessions open for this date given booked parties.
  const _bookedParties = [];
  for (const pid of PARTY_SLOT_IDS) {
    try { if (await getStore("parties").get(slotKey(date, pid), { type: "json" })) _bookedParties.push(pid); } catch {}
  }
  if (!openPlayForDate(date, effectivePartyBlocks(date, _bookedParties), hoursFor(date, _seasonal, _weekly)).some(s => s.id === slot))
                                        return json({ error: "That session isn't available on this date." }, 400);
  const cap = slotCap(slot);
  if (children < 1)                     return json({ error: "Select at least one child." }, 400);
  if (!name)                            return json({ error: "Please enter your full name." }, 400);
  if (!/^\S+@\S+\.\S+$/.test(email))    return json({ error: "Please enter a valid email." }, 400);
  if (sibling > 0 && regular < 1)       return json({ error: "Sibling add-on requires at least one regular admission." }, 400);
  if (children > cap)                   return json({ error: `A single booking can't exceed ${cap} children.` }, 400);

  const env = process.env;
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) {
    return json({ error: "Payments are not configured yet (missing Square keys)." }, 500);
  }

  // --- Validate punch cards and determine how many admissions they cover ---
  // Each pass covers ONE admission of its matching type per booking.
  const passStore = getStore("passes");
  const usablePasses = [];   // { code, admission, rec }
  for (const code of passCodes) {
    let prec = null;
    try { prec = await passStore.get("pass:" + code, { type: "json" }); } catch { prec = null; }
    if (!prec)                 return json({ error: "pass", message: `Pass ${code} wasn't found.` }, 409);
    if (prec.expiry && prec.expiry < new Date().toISOString().slice(0, 10))
                               return json({ error: "pass", message: `Pass ${code} has expired.` }, 409);
    // A punch card is active unless EXPLICITLY deactivated. Legacy cards were
    // written without an `active` field, so the old `!prec.active` test rejected
    // them outright — while passes-list.js (which uses `active === false`) still
    // showed them as Active in staff tools. That mismatch is exactly why a
    // customer with a visit clearly remaining was told her card had none.
    if (prec.active === false)
                               return json({ error: "pass", message: `Pass ${code} has been deactivated — please ask us at the desk.` }, 409);
    if ((prec.visitsRemaining || 0) < 1)
                               return json({ error: "pass", message: `Pass ${code} has no visits left.` }, 409);
    usablePasses.push({ code, admission: prec.admission, rec: prec });
  }
  const regPassesAvail = usablePasses.filter(p => p.admission === "regular");
  const infPassesAvail = usablePasses.filter(p => p.admission === "infant");
  const sibPassesAvail = usablePasses.filter(p => p.admission === "sibling");
  const coveredRegular = Math.min(regPassesAvail.length, regular);
  const coveredInfant  = Math.min(infPassesAvail.length, infant);
  const coveredSibling = Math.min(sibPassesAvail.length, sibling);
  const passesToUse = [
    ...regPassesAvail.slice(0, coveredRegular),
    ...infPassesAvail.slice(0, coveredInfant),
    ...sibPassesAvail.slice(0, coveredSibling),
  ];

  // Paid (uncovered) items only; covered admissions are $0 and untaxed (prepaid).
  const paidRegular = regular - coveredRegular;
  const paidInfant  = infant - coveredInfant;
  const paidSibling = sibling - coveredSibling;

  // Authoritative amounts (cents). Covered admissions are $0; only paid items are charged/taxed.
  const PRICES = await pricesFor();   // current prices — manually set ones always win
  const subtotal = paidRegular * PRICES.regular + paidInfant * PRICES.infant
    + paidSibling * PRICES.sibling + additionalAdults * additionalAdultCentsFor();

  // Automatic weekday special (e.g. "25% off Regular & Baby/Infant every Mon/Tue") —
  // triggers itself off the booking date, no code needed. Exclusive with a manual
  // discount code (both are blanket admission discounts); stacks fine with everything
  // else (gift cards, store credit, loyalty/birthday/classroom reward codes).
  const weekdaySpecial = await getWeekdaySpecial();
  let weekdaySpecialAmount = 0, weekdaySpecialLabel = "";
  const wdToday = weekdayOf(date);
  const weekdaySpecialActive = weekdaySpecial.enabled && weekdaySpecial.days.includes(wdToday);
  if (weekdaySpecialActive) {
    const at = weekdaySpecial.appliesTo || {};
    let eligibleSubtotal = 0, eligibleCount = 0;
    if (at.regular) { eligibleSubtotal += paidRegular * PRICES.regular; eligibleCount += paidRegular; }
    if (at.sibling) { eligibleSubtotal += paidSibling * PRICES.sibling; eligibleCount += paidSibling; }
    if (at.infant)  { eligibleSubtotal += paidInfant * PRICES.infant; eligibleCount += paidInfant; }
    weekdaySpecialAmount = weekdaySpecial.mode === "percent"
      ? Math.round(eligibleSubtotal * weekdaySpecial.amount / 100)
      : Math.min(eligibleSubtotal, eligibleCount * weekdaySpecial.amount);
    const types = [at.regular && "Regular", at.sibling && "Sibling", at.infant && "Baby/Infant"].filter(Boolean).join(" & ");
    const amountTxt = weekdaySpecial.mode === "percent" ? `${weekdaySpecial.amount}% off` : `$${(weekdaySpecial.amount / 100).toFixed(2)} off`;
    weekdaySpecialLabel = weekdaySpecial.label || `${amountTxt} ${types} admission`;
  }

  // Percent-off discount code: validate and apply to the subtotal (before tax).
  let discountPct = 0, discountAmount = 0, discRec = null;
  if (discountCode) {
    if (weekdaySpecialActive) return json({ error: "discount", message: `Today's ${weekdaySpecialLabel} is already applied automatically — a discount code can't be combined with it.` }, 409);
    const today = new Date().toISOString().slice(0, 10);
    const discStore = getStore("discounts");
    try { discRec = await discStore.get("disc:" + discountCode, { type: "json" }); } catch { discRec = null; }
    if (!discRec)                                   return json({ error: "discount", message: `Discount code ${discountCode} wasn't found.` }, 409);
    // Same active-flag contract as passes and credits.
    if (discRec.used || discRec.active === false)   return json({ error: "discount", message: `Discount code ${discountCode} has already been used.` }, 409);
    if (discRec.expiry && discRec.expiry < today)   return json({ error: "discount", message: `Discount code ${discountCode} has expired.` }, 409);
    discountPct = Math.max(0, Math.min(100, discRec.percent || 0));
    discountAmount = Math.round(subtotal * discountPct / 100);
  }

  // Military discount: 10% off, per CHILD whose loyalty card has been staff-verified
  // as military (checked ID in person, toggled on their card) — never the adult
  // add-on. Mutually exclusive with the Weekday Special / a discount code: only ONE
  // blanket discount ever applies to a booking, whichever is worth more in dollars.
  let militaryAmount = 0;
  const militaryChildren = [];
  if (childNames.some(c => c.code)) {
    const loyaltyStore = getStore("loyalty");
    for (const ch of childNames) {
      if (!ch.code || !ch.admission) continue;
      let card = null; try { card = await loyaltyStore.get("card:" + ch.code, { type: "json" }); } catch {}
      if (card && card.militaryVerified) {
        const price = ch.admission === "sibling" ? PRICES.sibling : ch.admission === "infant" ? PRICES.infant : PRICES.regular;
        militaryAmount += price;
        militaryChildren.push(cleanName(ch.first, ch.last));
      }
    }
    militaryAmount = Math.round(militaryAmount * 0.10);
  }
  // Reconcile: general (discount code or weekday special — already exclusive with
  // each other) vs. military — only the bigger one survives.
  if (militaryAmount > 0) {
    const generalAmount = Math.max(discountAmount, weekdaySpecialAmount);
    if (militaryAmount > generalAmount) {
      discountAmount = 0; discountPct = 0;
      weekdaySpecialAmount = 0; weekdaySpecialLabel = "";
    } else {
      militaryAmount = 0;
    }
  }

  // Loyalty free-visit reward: one earned visit = one free child admission of ANY
  // type at the current price. It zeroes the single most-expensive child admission
  // in the booking. Single-use. Gift cards may still be used alongside it (they're a
  // payment method, not a promo) — a discount code or store credit may not.
  const rewardCode = (body.rewardCode || "").toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  let rewardAmount = 0, rewardRec = null;
  // A reward/birthday code's validFrom/expiry describe when the VISIT is allowed —
  // e.g. a birthday code good August 16-23 — so every check below compares against
  // `date` (the play date the customer picked), never today's real-world date.
  // Comparing against "today" was a real bug: a customer booking in advance for a
  // date inside the code's valid window (entirely normal — people book ahead) would
  // get incorrectly rejected as "not valid yet" days before their actual visit.
  // ---- Owner's family master code -------------------------------------------
  // Zeroes the WHOLE admission total, any headcount, unlimited uses, no expiry.
  // Everything else about the booking behaves normally: it takes real capacity,
  // names are still collected, a confirmation still goes out, and the visit is
  // recorded — it just isn't paid for and earns no punches.
  let famUsed = null;
  if (rewardCode) {
    const fam = await getActiveFamCode();
    if (fam && rewardCode === fam.code.toUpperCase().replace(/[^A-Z0-9]/g, "")) {
      const maxKids = fam.maxChildren || 6;
      const kidCount = regular + sibling + infant;
      if (kidCount < 1) return json({ error: "reward", message: "Add at least one child." }, 409);
      if (kidCount > maxKids) {
        return json({ error: "reward",
          message: `The family code covers up to ${maxKids} children per booking. Please split this into two bookings.` }, 409);
      }
      famUsed = fam;
      // No punches for any child on a free booking.
      for (const ch of childNames) ch._freeAdmission = true;
    }
  }

  if (rewardCode && !famUsed) {
    if (discountCode) return json({ error: "reward", message: "A free-visit reward can't be combined with a discount code." }, 409);
    if (hasStoreCredit) return json({ error: "reward", message: "A free-visit reward can't be combined with store credit." }, 409);
    const rewardStore = getStore("rewards");
    try { rewardRec = await rewardStore.get("reward:" + rewardCode, { type: "json" }); } catch { rewardRec = null; }
    if (!rewardRec) {
      await logFailedCode({ code: rewardCode, reason: "not found", name, email, phone });
      return json({ error: "reward", message: `Free-visit code ${rewardCode} wasn't found.` }, 409);
    }
    if (rewardRec.used) {
      await logFailedCode({ code: rewardCode, reason: "already used", name, email, phone });
      return json({ error: "reward", message: `Free-visit code ${rewardCode} has already been used.` }, 409);
    }
    if (rewardRec.validFrom && date < rewardRec.validFrom) {
      await logFailedCode({ code: rewardCode, reason: `not valid until ${rewardRec.validFrom}`, name, email, phone });
      return json({ error: "reward", message: rewardRec.kind === "birthday"
        ? (rewardRec.expiry && rewardRec.expiry !== rewardRec.validFrom
            ? `🎂 This birthday gift can be used any day between ${rewardRec.validFrom} and ${rewardRec.expiry} — see you then!`
            : `🎂 This birthday gift can be used on ${rewardRec.validFrom} — see you then!`)
        : `Free-visit code ${rewardCode} isn't valid until ${rewardRec.validFrom}.` }, 409);
    }
    if (rewardRec.expiry && rewardRec.expiry < date) {
      await logFailedCode({ code: rewardCode, reason: `expired ${rewardRec.expiry}`, name, email, phone });
      return json({ error: "reward", message: rewardRec.kind === "birthday"
        ? (rewardRec.validFrom && rewardRec.validFrom !== rewardRec.expiry
            ? `🎂 This birthday gift was good between ${rewardRec.validFrom} and ${rewardRec.expiry} only and has expired.`
            : `🎂 This birthday gift was good on ${rewardRec.expiry} only and has expired.`)
        : `Free-visit code ${rewardCode} has expired.` }, 409);
    }
    // Value = one admission of the most expensive child type present in the cart.
    const present = [];
    if (regular > 0) present.push(PRICES.regular);
    if (sibling > 0) present.push(PRICES.sibling);
    if (infant  > 0) present.push(PRICES.infant);
    if (!present.length) return json({ error: "reward", message: "Add a child admission to use your free-visit reward." }, 409);
    rewardAmount = Math.min(Math.max(...present), subtotal - discountAmount - weekdaySpecialAmount - militaryAmount);
    // Tag the specific child whose admission type this covered — so check-in knows
    // NOT to issue a loyalty punch for that child's visit (it wasn't paid for).
    const rewardType = Math.max(...present) === PRICES.regular ? "regular" : Math.max(...present) === PRICES.infant ? "infant" : "sibling";
    const rewardChild = childNames.find(c => c.admission === rewardType && !c._freeAdmission);
    if (rewardChild) rewardChild._freeAdmission = true;
  }

  // Birthday rewards: one per child, attached to that SPECIFIC child's row (not just
  // "the most expensive admission"), so twins/siblings can each redeem their own gift
  // on the same booking. Same combinability rules as the free-visit reward above.
  let birthdayAmount = 0;
  const birthdayApplied = [];   // [{ code, rec, childName }]
  const birthdayWarnings = [];
  const birthdayRows = childNames.filter(c => c.birthdayCode);
  if (birthdayRows.length) {
    if (discountCode) return json({ error: "reward", message: "A birthday reward can't be combined with a discount code." }, 409);
    if (hasStoreCredit) return json({ error: "reward", message: "A birthday reward can't be combined with store credit." }, 409);
    const rewardStore = getStore("rewards");
    const usedCodes = new Set();
    for (const ch of birthdayRows) {
      const bc = ch.birthdayCode;
      if (usedCodes.has(bc)) return json({ error: "reward", message: `Birthday code ${bc} was entered more than once.` }, 409);
      usedCodes.add(bc);
      let r = null; try { r = await rewardStore.get("reward:" + bc, { type: "json" }); } catch { r = null; }
      if (!r) {
        await logFailedCode({ code: bc, reason: "not found", name, email, phone });
        return json({ error: "reward", message: `Birthday code ${bc} wasn't found.` }, 409);
      }
      if (r.used) {
        await logFailedCode({ code: bc, reason: "already used", name, email, phone });
        return json({ error: "reward", message: `Birthday code ${bc} has already been used.` }, 409);
      }
      if (r.validFrom && date < r.validFrom) {
        await logFailedCode({ code: bc, reason: `not valid until ${r.validFrom}`, name, email, phone });
        return json({ error: "reward", message: (r.expiry && r.expiry !== r.validFrom)
          ? `🎂 Birthday code ${bc} can be used any day between ${r.validFrom} and ${r.expiry} — see you then!`
          : `🎂 Birthday code ${bc} can be used on ${r.validFrom} — see you then!` }, 409);
      }
      if (r.expiry && r.expiry < date) {
        await logFailedCode({ code: bc, reason: `expired ${r.expiry}`, name, email, phone });
        return json({ error: "reward", message: (r.validFrom && r.validFrom !== r.expiry)
          ? `🎂 Birthday code ${bc} was good between ${r.validFrom} and ${r.expiry} only and has expired.`
          : `🎂 Birthday code ${bc} was good on ${r.expiry} only and has expired.` }, 409);
      }
      const admissionType = ch.admission || "regular";
      const price = admissionType === "sibling" ? PRICES.sibling : admissionType === "infant" ? PRICES.infant : PRICES.regular;
      birthdayAmount += Math.min(price, subtotal - discountAmount - weekdaySpecialAmount - militaryAmount - rewardAmount - birthdayAmount);
      birthdayApplied.push({ code: bc, rec: r, childName: cleanName(ch.first, ch.last) });
      ch._freeAdmission = true;
      // Soft, non-blocking heads-up if the name on the booking doesn't match who the code was issued to.
      const onFile = (r.childName || "").toLowerCase().replace(/\s+/g, " ").trim();
      const entered = cleanName(ch.first, ch.last).toLowerCase().replace(/\s+/g, " ").trim();
      if (onFile && entered && onFile !== entered) {
        birthdayWarnings.push(`Heads up: birthday code ${bc} was issued for "${r.childName}," but you entered "${cleanName(ch.first, ch.last)}" — just double-checking, still happy to honor it.`);
      }
    }
  }

  // Grip socks: a physical add-on, so it is charged even when admission is free.
  const gripSocks = (() => { try { return Math.max(0, Math.min(GRIP_SOCK_MAX, parseInt(body.gripSocks, 10) || 0)); } catch { return 0; } })();
  const gripSocksAmount = gripSocks * GRIP_SOCK_CENTS;

  // ---- Play Club membership --------------------------------------------
  // A member's monthly subscription already covers admission, so the whole
  // admission total goes to zero. The visit still takes real capacity and still
  // shows on the roster; it just isn't charged and earns no punches.
  let member = null, memberAmount = 0, memberCoveredKids = [], memberCoveredCount = 0;
  const pcCode = (body.playClubCode || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Only look up a membership when a code was typed, or when the phone matches.
  // Wrapped so a fault in the membership store can never stop an ordinary
  // booking — this is an optional feature sitting in the critical path.
  let found = null;
  try { if (pcCode || phone) found = await findMemberFor({ code: pcCode, phone }); }
  catch { found = null; }
  if (pcCode || phone) {
    if (found) {
      const kidCount = regular + sibling + infant;
      if (kidCount < 1) return json({ error: "playclub", message: "Choose which children are coming." }, 409);

      // A Weekday plan is priced below Any Day precisely because it excludes
      // weekends. Refuse rather than quietly covering it, so the total the page
      // showed and the total we charge can never disagree.
      if (!memberCoversDate(found, date)) {
        return json({ error: "playclub",
          message: `${found.planName || "Your Weekday Play Club"} covers Monday to Friday only. `
            + `Please pick a weekday, or book this visit as normal admission — upgrade to an Any Day plan any time.` }, 409);
      }

      const cap = Math.max(1, found.maxChildren || (found.children || []).length || 1);

      // Work out WHICH children are covered rather than treating the booking as
      // all-or-nothing. Previously anything over the cap was rejected outright,
      // so a member bringing one extra friend couldn't book at all; now the
      // membership covers its own children and the extras are simply charged.
      const normName = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
      const memKids  = found.children || [];
      const memCodes = new Set(memKids.map(c => String(c.code || "").toUpperCase()).filter(Boolean));
      const memNames = new Set(memKids.map(c => normName(c.name)).filter(Boolean));

      // One entry per admission actually being booked, so coverage is decided
      // per admission and priced with that admission's own rate.
      const admSlots = [];
      for (let i = 0; i < regular; i++) admSlots.push({ admission: "regular", price: PRICES.regular });
      for (let i = 0; i < sibling; i++) admSlots.push({ admission: "sibling", price: PRICES.sibling });
      for (let i = 0; i < infant;  i++) admSlots.push({ admission: "infant",  price: PRICES.infant  });
      for (const ch of childNames) {
        const s = admSlots.find(x => !x.child && x.admission === (ch.admission || "regular"));
        if (s) s.child = ch;
      }

      const onMembership = s => !!(s.child && (
        (s.child.code && memCodes.has(String(s.child.code).toUpperCase())) ||
        memNames.has(normName((s.child.first || "") + (s.child.last || "")))
      ));

      let pool = admSlots.filter(onMembership);
      // No names given at all (bookings don't strictly require them) — fall back
      // to covering up to the cap so a member is never worse off for skipping
      // the name fields.
      if (!pool.length && !childNames.length) pool = admSlots.slice();
      // Dearest first, so a mixed booking always resolves in the family's favour.
      pool.sort((a, b) => b.price - a.price);
      const coveredSlots = pool.slice(0, cap);

      for (const s of coveredSlots) {
        memberAmount += s.price;
        memberCoveredCount++;
        if (s.child) {
          // Covered admissions earn no punch — same rule as the family code.
          s.child._freeAdmission = true;
          memberCoveredKids.push(cleanName(s.child.first, s.child.last));
        }
      }
      member = found;
    } else if (pcCode) {
      return json({ error: "playclub", message: "We don't recognise that membership code. Please check it or leave it blank." }, 409);
    }
  }

  // ---- Referral: $5 off, new families only -------------------------------
  // Re-verified here every time. The browser check only exists to show the
  // discount early; it is never trusted.
  let referral = null, referralAmount = 0;
  const refCode = (() => { try { return normalizeRef(body.refCode || body.referralCode || ""); } catch { return ""; } })();
  if (refCode) { try {
    const refFam = await findFamilyByCode(refCode);
    const myP4 = refLast4(phone);
    // Same rule as /api/referrals check — the page and the server must never
    // disagree about whether this discount applies.
    const famStatus = await familyStatus({ phone, email, childNames,
      childCodes: childNames.map(c => c && c.code).filter(Boolean) });

    // If the browser sent a code we won't honour, STOP — don't quietly charge a
    // different total than the page displayed. Tell them why and let the page
    // recalculate. Silently dropping the discount is what made the total lie.
    if (!refFam) {
      return json({ error: "referral", message: "We don't recognise that referral code. Please remove it and try again." }, 409);
    }
    if (myP4 && myP4 === refFam.phone4) {
      return json({ error: "referral", message: "That's your own referral code — it can't be used on your own booking. Please remove it." }, 409);
    }
    // A free-admission code (loyalty, birthday or classroom) already covers a
    // child, so the referral discount doesn't stack on top of it.
    // A free-admission code already covers a child, so the referral simply
    // doesn't apply. Silently skip it rather than refusing the booking — a
    // stale code in the form should never stop someone paying.
    if (rewardAmount > 0 || birthdayAmount > 0) {
      referral = null; referralAmount = 0;
    } else
    if (!famStatus.isNew) {
      return json({ error: "referral", message:
        "The referral discount is a welcome offer for families who haven't visited us before, and it looks like you've already played with us"
        + (famStatus.match ? ` (${famStatus.match})` : "")
        + ". Please remove the referral code. If you've earned referral credit, its code starts with LHC and goes in the store credit box." }, 409);
    }

    if (myP4) {
      referral = refFam;
      // A close-but-not-exact name match. The discount still applies — refusing
      // on a fuzzy match would turn away genuinely new families — but the
      // referrer's $5 is held until a human looks at it.
      if (famStatus.suspect) { referral._suspect = true; referral._suspectMatch = famStatus.suspectMatch || ""; }
      referralAmount = Math.min(FRIEND_DISCOUNT_CENTS,
        Math.max(0, subtotal - discountAmount - weekdaySpecialAmount - militaryAmount - rewardAmount - birthdayAmount));
    }
  } catch { referral = null; referralAmount = 0; } }

  // The family code zeroes everything, whatever the headcount.
  // The membership covers ONLY the admissions it actually applies to (worked out
  // above), so an extra child booked alongside a membership still gets charged.
  // Clamped to what's left after other discounts so it can never push a total
  // negative or double-discount an admission a reward already covered.
  memberAmount = member
    ? Math.min(memberAmount,
        Math.max(0, subtotal - discountAmount - weekdaySpecialAmount - militaryAmount - rewardAmount - birthdayAmount - referralAmount))
    : 0;

  const famAmount = famUsed
    ? Math.max(0, subtotal - discountAmount - weekdaySpecialAmount - militaryAmount - rewardAmount - birthdayAmount - referralAmount - memberAmount)
    : 0;
  // Add-ons sit outside every discount — they are goods, not admission.
  const taxable = Math.max(0, subtotal - discountAmount - weekdaySpecialAmount - militaryAmount - rewardAmount - birthdayAmount - referralAmount - memberAmount - famAmount) + gripSocksAmount;
  // No sales tax: recreational/amusement admission is CDTFA-exempt (intangible admission),
  // so this business does not collect sales tax on any admission, party, or gift card sale.
  const tax = 0;
  const amount = taxable;                        // total due (may be $0 if fully covered)

  const store = getStore("bookings");
  const key = slotKey(date, slot);

  // Reserved for a private party? A block on either the :00 or the :30 reserves the
  // whole shared hour, so check every mate before allowing a booking into it.
  try {
    const blocksStore = getStore("blocks");
    for (const mid of hourMatesFor(slot)) {
      if (await blocksStore.get(slotKey(date, mid), { type: "json" }))
        return json({ error: "reserved", message: "That session is reserved for a private party." }, 409);
    }
  } catch {}

  // Capacity check: this arrival shares one pool of `cap` children with its :00/:30
  // partner (and any legacy session for the same hour), so a 1:00 and a 1:30 booking
  // draw from the SAME 6 and the room is never oversold.
  const current = await countHourChildren(store, date, slot);
  if (current + children > cap) {
    const remaining = Math.max(0, cap - current);
    return json({ error: "full", remaining,
      message: `Only ${remaining} spot${remaining === 1 ? "" : "s"} left in that hour.` }, 409);
  }

  const note = `Open Play ${date} ${slot} - ${regular} reg + ${sibling} sib + ${infant} infant`;

  // Validate gift cards and allocate against the total (gift cards pay first).
  let due = amount;
  const giftApplied = [];   // { gan, id, applied }
  for (const gan of giftCardCodes) {
    let gc;
    try {
      const r = await fetch(`${squareApiBase()}/v2/gift-cards/from-gan`, {
        method: "POST",
        headers: { "Square-Version": SQUARE_VERSION, "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ gan }),
      });
      const d = await r.json();
      if (!r.ok || !d.gift_card || d.gift_card.state !== "ACTIVE") {
        return json({ error: "giftcard", message: `Gift card ${gan} isn't valid or active.` }, 409);
      }
      gc = d.gift_card;
    } catch (e) {
      return json({ error: "giftcard", message: "Couldn't verify a gift card right now." }, 502);
    }
    const bal = gc.balance_money?.amount || 0;
    const applied = Math.min(due, bal);
    if (applied > 0) { giftApplied.push({ gan, id: gc.id, applied }); due -= applied; }
  }

  // Store credit (promo code) applies after gift cards, before the card.
  let creditApplied = 0; let creditRec = null; let creditRemaining = null;
  const promoCode = (body.promoCode || "").toString().trim().toUpperCase();
  if (promoCode && due > 0) {
    const creditStore = getStore("credits");
    try { creditRec = await creditStore.get("credit:" + promoCode, { type: "json" }); } catch { creditRec = null; }
    if (!creditRec) return json({ error: "promo", message: `Promo code ${promoCode} wasn't found.` }, 409);
    if (creditRec.expiry && creditRec.expiry < new Date().toISOString().slice(0, 10))
      return json({ error: "promo", message: `Promo code ${promoCode} has expired.` }, 409);
    // Same contract as punch cards: only an explicit false means deactivated.
    if (creditRec.active === false || (creditRec.amount || 0) < 1)
      return json({ error: "promo", message: `Promo code ${promoCode} has no balance left.` }, 409);
    creditApplied = Math.min(due, creditRec.amount);
    due -= creditApplied;
  }

  const cardAmount = due;   // remainder to charge to the credit card
  if (cardAmount > 0 && !sourceId) {
    return json({ error: "card_required", message: "A card is needed for the remaining balance." }, 400);
  }

  // Gift cards are redeemed FIRST because they're the only leg we can reverse
  // cleanly; the card goes last, so a failure never leaves card money taken for
  // a booking that was not created. If the card leg fails after gift cards were
  // drawn down, every gift card redemption is refunded before returning.
  const payments = [];
  const attemptId = (body.attemptId || "").toString().slice(0, 60);
  const idemBase = [attemptId, email, date, slot, amount];
  try {
    for (const g of giftApplied) {
      const p = await chargeSquare(env, {
        source_id: g.id, amount: g.applied, note, email,
        idem: idemKey([...idemBase, "gift", g.gan, g.applied]),
      });
      if (!p.ok) {
        await refundAll(env, payments);
        return json({ error: "giftcard", message: `Couldn't redeem gift card ${g.gan}.` }, 402);
      }
      payments.push(p.payment);
      g.balanceAfter = p.giftCardBalance;
    }
    if (cardAmount > 0) {
      const p = await chargeSquare(env, {
        source_id: sourceId, amount: cardAmount, note, email,
        idem: idemKey([...idemBase, "card", cardAmount]),
      });
      if (!p.ok) {
        await refundAll(env, payments);
        return json({ error: "payment_failed", message: p.detail }, 402);
      }
      payments.unshift(p.payment);   // keep the card payment first, as before
    }
  } catch (e) {
    await refundAll(env, payments);
    return json({ error: "payment_error", message: "Could not reach the payment processor." }, 502);
  }
  const payment = payments[0] || null;
  // Last 4 digits of the credit/debit card used (from Square's payment response),
  // so staff can match this booking to the Square transaction at check-in. Only
  // the last 4 is stored — that's explicitly permitted under PCI and is never the
  // full card number. Null when nothing was charged to a card (gift card / credit / free).
  const cardPayment = payments.find(p => p && p.card_details && p.card_details.card && p.card_details.card.last_4);
  const cardLast4 = cardPayment ? String(cardPayment.card_details.card.last_4).replace(/\D/g, "").slice(-4) : null;

  // Spend store credit (if used).
  if (creditApplied > 0 && creditRec) {
    const creditStore = getStore("credits");
    let fresh = creditRec;
    try { fresh = await creditStore.get("credit:" + promoCode, { type: "json" }) || creditRec; } catch {}
    if (fresh.singleUse || fresh.type === "courtesy") {
      // One-time use: any unused balance is forfeited after redemption.
      fresh.amount = 0;
      fresh.active = false;
    } else {
      fresh.amount = Math.max(0, (fresh.amount ?? creditRec.amount) - creditApplied);
    }
    fresh.history = Array.isArray(fresh.history) ? fresh.history : [];
    fresh.history.push({ at: new Date().toISOString(), action: "redeemed-online", amount: creditApplied, where: "online open play" });
    try { await creditStore.setJSON("credit:" + promoCode, fresh); } catch {}
    creditRemaining = fresh.amount || 0;
  }

  // Payment succeeded (or nothing was owed) — now spend one visit from each used pass.
  const passesUsed = [];
  let freeVisitCard = null;   // set if a card's FREE (8th) visit was just used
  for (const up of passesToUse) {
    let fresh = up.rec;
    try { fresh = await passStore.get("pass:" + up.code, { type: "json" }) || up.rec; } catch {}
    const after = Math.max(0, (fresh.visitsRemaining ?? up.rec.visitsRemaining) - 1);
    fresh.visitsRemaining = after;
    fresh.usage = Array.isArray(fresh.usage) ? fresh.usage : [];
    fresh.usage.push({ at: new Date().toISOString(), count: 1, where: "online", date });
    // "Buy 7, 8th free": the visit that empties the card is the free one. Celebrate
    // and (once per empty cycle) email a same-code reload reminder.
    let emailedReminder = false;
    if (after === 0) {
      freeVisitCard = { code: up.code, childName: fresh.childName || "" };
      if (!fresh.reminderSentAt) {
        try { const loyalty = getStore("loyalty"); await graduateLegacyCard(loyalty, fresh); fresh.reminderSentAt = new Date().toISOString(); emailedReminder = true; } catch {}
      }
    }
    try { await passStore.setJSON("pass:" + up.code, fresh); } catch {}
    passesUsed.push({ code: up.code, admission: up.admission, visitsRemaining: after, total: (fresh.visits || (up.rec && up.rec.visits) || null), freeVisit: after === 0 });
  }

  // Burn the one-time discount code (payment already succeeded).
  if (discountCode && discRec) {
    const discStore = getStore("discounts");
    let fresh = discRec;
    try { fresh = await discStore.get("disc:" + discountCode, { type: "json" }) || discRec; } catch {}
    fresh.used = true; fresh.active = false;
    fresh.usedAt = new Date().toISOString(); fresh.usedBy = email; fresh.bookingId = payment?.id || null;
    try { await discStore.setJSON("disc:" + discountCode, fresh); } catch {}
  }

  // Burn the loyalty free-visit reward (payment already succeeded).
  if (rewardCode && rewardRec) {
    const rewardStore = getStore("rewards");
    let fresh = rewardRec;
    try { fresh = await rewardStore.get("reward:" + rewardCode, { type: "json" }) || rewardRec; } catch {}
    fresh.used = true;
    fresh.usedAt = new Date().toISOString(); fresh.usedBy = email; fresh.bookingId = payment?.id || null;
    try { await rewardStore.setJSON("reward:" + rewardCode, fresh); } catch {}
  }

  // Burn each birthday reward used, and clear it off the linked loyalty card.
  if (birthdayApplied.length) {
    const rewardStore = getStore("rewards");
    const loyaltyStore = getStore("loyalty");
    for (const b of birthdayApplied) {
      let fresh = b.rec;
      try { fresh = await rewardStore.get("reward:" + b.code, { type: "json" }) || b.rec; } catch {}
      fresh.used = true;
      fresh.usedAt = new Date().toISOString(); fresh.usedBy = email; fresh.bookingId = payment?.id || null;
      try { await rewardStore.setJSON("reward:" + b.code, fresh); } catch {}
      const lc = fresh.loyaltyCode;
      if (lc) {
        try {
          const card = await loyaltyStore.get("card:" + lc, { type: "json" });
          if (card && card.activeBirthdayCode === b.code) {
            delete card.activeBirthdayCode; delete card.activeBirthdayExpiry;
            await loyaltyStore.setJSON("card:" + lc, card);
          }
        } catch {}
      }
    }
  }

  // Record the booking. Strong-consistency re-read so two near-simultaneous bookings
  // (or a booking landing on a slot another write just touched) can't stale-read an
  // older copy and overwrite each other — the same class of bug that dropped a
  // rescheduled family. Each write appends onto the truly-latest record.
  let latest = null;
  try { latest = await store.get(key, { type: "json", consistency: "strong" }); } catch { latest = null; }
  const base = latest && typeof latest.children === "number"
    ? latest : { children: 0, bookings: [] };

  base.bookings = base.bookings || [];
  const bookingId = crypto.randomUUID();
  const legacyUsed = passesUsed.length > 0;   // a legacy prepaid card was redeemed
  base.bookings.push({
    id: bookingId,
    name, email, phone, childNames, parentName: name, legacyUsed,
    regular, sibling, infant, adults: totalAdults, adultsTotal: totalAdults, additionalAdults,
    coveredRegular, coveredInfant, coveredSibling,
    subtotal, tax, amount,
    cardPaid: cardAmount,
    giftCards: giftApplied.map(g => ({ gan: g.gan, applied: g.applied, balanceAfter: g.balanceAfter ?? null })),
    creditApplied, promoCode: creditApplied > 0 ? promoCode : null,
    // Stamped so check-in can pay the referrer. Payout happens on ARRIVAL, never
    // on booking — a no-show must not earn anyone $5.
    gripSocks, gripSocksAmount,
    playClubCode: member ? member.code : null,
    playClubName: member ? (member.planName || "Play Club") : null,
    playClubAmount: memberAmount || 0,
    // How many admissions the membership actually covered on this booking, and
    // who they were. A member bringing an extra child pays for that child, so
    // "covered" is no longer the same as "everyone on the booking".
    playClubCovered: member ? memberCoveredCount : 0,
    playClubCoveredKids: member ? memberCoveredKids : [],
    referredBy: referral ? referral.code : null,
    referralAmount: referralAmount || 0,
    referralPaid: false,
    referralNeedsReview: !!(referral && referral._suspect),
    referralSuspectMatch: (referral && referral._suspectMatch) || null,
    discountCode: discountAmount > 0 ? discountCode : null, discountPct, discountAmount,
    weekdaySpecialAmount, weekdaySpecialLabel: weekdaySpecialAmount > 0 ? weekdaySpecialLabel : "",
    militaryAmount, militaryChildren: militaryAmount > 0 ? militaryChildren : [],
    passesUsed,
    paymentId: payment?.id || null,
    cardLast4,
    at: new Date().toISOString(),
  });
  base.children = (base.children || 0) + children;

  // The customer has already paid, so we still report success to them — but a
  // write failure here means the booking is NOT on the roster. Alert the studio
  // immediately with everything needed to add it by hand.
  // Family code: log the use and alert the owner. This is the tripwire — if the
  // code ever leaks, an email lands the same day rather than being noticed weeks
  // later in the takings.
  if (famUsed) {
    const lbl = (SLOTS.find(s => s.id === slot) || {}).label || slot;
    await logFamUse({
      code: famUsed.code, date, slot, slotLabel: lbl,
      name, email, phone,
      children: regular + sibling + infant, adults: totalAdults,
      regular, sibling, infant,
      valueWaived: famAmount,
      children_names: childNames.map(c => cleanName(c.first, c.last)).filter(Boolean),
    });
    try {
      await sendOwnerAlert(
        `👨‍👩‍👧 Family code used — ${date} ${lbl}`,
        `<h3>The family master code was used</h3>
         <p><b>${date} · ${lbl}</b><br>
         Booked by <b>${name}</b> — ${email}${phone ? " — " + phone : ""}<br>
         ${regular} regular · ${sibling} sibling · ${infant} infant · ${totalAdults} adult(s)<br>
         Admission waived: <b>$${(famAmount / 100).toFixed(2)}</b><br>
         Code: <code>${famUsed.code}</code></p>
         <p>If you didn't expect this booking, rotate the code in the admin tools
         straight away — the old code stops working the moment you do.</p>`,
        famUsed.notifyEmail || undefined
      );
    } catch {}
  }

  // Log the referral as pending so it appears in the staff history straight away,
  // not only once the friend turns up.
  if (referral) {
    try {
      const rstore = getStore("referrals");
      await rstore.setJSON("ref:" + bookingId, {
        id: bookingId, refCode: referral.code,
        referrerPhone4: referral.phone4, referrerName: referral.name || "",
        friendPhone4: refLast4(phone), friendName: name, friendEmail: email,
        source: "online", at: new Date().toISOString(),
        bookingDate: date, slot, discountGiven: referralAmount,
        paidAt: null, creditCode: null,
        needsReview: !!referral._suspect,
        suspectMatch: referral._suspectMatch || null,
      });
    } catch {}
  }

  // Count the visit against the membership so the staff view shows usage.
  if (member) {
    try {
      await recordMemberVisit(member.code, {
        date, slot,
        slotLabel: (SLOTS.find(s => s.id === slot) || {}).label || slot,
        // Count what the MEMBERSHIP covered, not the whole booking. A member who
        // brings a paying friend hasn't used two of their allowance, and the
        // usage figures decide whether a tier is priced right.
        count: memberCoveredCount,
        total: regular + sibling + infant,
        children: memberCoveredKids.length
          ? memberCoveredKids
          : childNames.map(c => cleanName(c.first, c.last)).filter(Boolean),
        bookedBy: name,
      });
    } catch {}
  }

  try { await store.setJSON(key, base); }
  catch (e) {
    try {
      const lbl = (SLOTS.find(s => s.id === slot) || {}).label || slot;
      await sendOwnerAlert(
        "🚨 PAID BOOKING NOT SAVED — please add by hand",
        `<h3>A booking was paid for but could not be written to the roster</h3>
         <p><b>${date} · ${lbl}</b><br>
         <b>${name}</b> — ${email} — ${phone || "no phone given"}<br>
         ${regular} regular · ${sibling} sibling · ${infant} infant<br>
         Paid by card: <b>$${(cardAmount / 100).toFixed(2)}</b>${payment?.id ? ` · Square payment ${payment.id}` : ""}</p>
         <p>The customer has been told they're booked. Please add them to the roster manually.</p>`
      );
    } catch {}
  }

  // ---- Loyalty punch card: auto-issue each child's code + welcome email at booking.
  // Skipped entirely when a legacy prepaid card was used (legacy never joins loyalty
  // for that visit). The actual PUNCH happens later, at check-in (see arrivals.js).
  const phone4 = loyaltyLast4(phone);
  let loyaltyCards = [];   // each child's punch card — folded into the ONE confirmation email
  if (!legacyUsed && phone4 && childNames.length) {
    const loyalty = getStore("loyalty");
    const issued = [];
    for (const ch of childNames) {
      try {
        let r;
        if (ch.code) {
          // Family already gave their existing loyalty code — claim that exact card
          // rather than re-resolving by name (which could land on the wrong sibling).
          let existing = null; try { existing = await loyalty.get("card:" + ch.code, { type: "json" }); } catch {}
          if (existing) {
            let changed = false;
            if (email && !existing.buyerEmail) { existing.buyerEmail = email; changed = true; }
            if (phone && !existing.phone) { existing.phone = phone; changed = true; }
            if (ch.dob && !existing.dob) { existing.dob = ch.dob; changed = true; }
            if (changed) { try { await loyalty.setJSON("card:" + ch.code, existing); } catch {} }
            r = { code: ch.code, isNew: false, childName: existing.childName };
          } else {
            // Code didn't actually exist (shouldn't happen — the booking page only
            // accepts codes it already verified) — fall back to name-based issuing.
            r = await issueCode(loyalty, { first: ch.first, last: ch.last, phone4, email, dob: ch.dob, suppressEmail: true });
          }
        } else {
          r = await issueCode(loyalty, { first: ch.first, last: ch.last, phone4, email, dob: ch.dob, suppressEmail: true });
          // New/looked-up card by name — also save the full phone number if we don't have one yet.
          if (r && r.code && phone) {
            try {
              const card = await loyalty.get("card:" + r.code, { type: "json" });
              if (card && !card.phone) { card.phone = phone; await loyalty.setJSON("card:" + r.code, card); }
            } catch {}
          }
        }
        if (r) issued.push(r);
      } catch {}
    }
    // Fold each child's punch card into the ONE confirmation email below — no separate
    // welcome email at booking. Read current punches so returning families see progress.
    for (const r of issued) {
      if (!r || !r.code) continue;
      let punches = 0;
      try { const card = await loyalty.get("card:" + r.code, { type: "json" }); if (card && typeof card.punches === "number") punches = card.punches; } catch {}
      loyaltyCards.push({ childName: r.childName, code: r.code, isNew: !!r.isNew, punches, needed: PUNCHES_FOR_REWARD });
    }
    // Queue a punch job for this booking; check-in (arrivals) will punch each child once.
    try { await getStore("loyaltyjobs").setJSON("job:" + bookingId,
      { children: childNames, phone4, email, punched: false, date, at: new Date().toISOString(),
        slotLabel: (SLOTS.find(s => s.id === slot) || {}).label || slot,
        discountCode: discountAmount > 0 ? discountCode : null, discountPct,
        weekdaySpecialLabel: weekdaySpecialAmount > 0 ? weekdaySpecialLabel : "",
        militaryAmount, militaryChildren: militaryAmount > 0 ? militaryChildren : [] }); } catch {}
  }

  // Save any birthdays the family chose to share, so we can send a birthday gift.
  // Key is month-first (bd:MM:DD:slug) so the admin list can pull a whole month cheaply.
  // (Birthdays are saved directly onto each child's loyalty card above — see the
  // dob handling in the loyalty punch card block — so there's no separate list to keep in sync.)

  // Send confirmation email (best-effort; never blocks a successful booking)
  const slotLabel = (SLOTS.find(s => s.id === slot) || {}).label || slot;
  const giftTotal = giftApplied.reduce((n, g) => n + g.applied, 0);
  try {
    await sendConfirmation({ email, name, date, slotLabel, regular, sibling, infant, adults: totalAdults, additionalAdults,
      coveredRegular, coveredInfant, coveredSibling, paidRegular, paidInfant, paidSibling, subtotal, tax, amount,
      giftApplied, giftTotal, creditApplied, creditRemaining, cardAmount, passesUsed, discountPct, discountAmount, weekdaySpecialAmount, weekdaySpecialLabel, militaryAmount, militaryChildren, loyaltyCards });
  } catch (e) { /* ignore email errors */ }

  return json({
    ok: true,
    children,
    subtotal,
    tax,
    amount,
    giftApplied: giftApplied.map(g => ({ gan: g.gan, applied: g.applied, balanceAfter: g.balanceAfter ?? null })),
    giftTotal,
    creditApplied,
    discountPct, discountAmount, discountCode: discountAmount > 0 ? discountCode : null,
    weekdaySpecialAmount, weekdaySpecialLabel: weekdaySpecialAmount > 0 ? weekdaySpecialLabel : "",
    militaryAmount, militaryChildren: militaryAmount > 0 ? militaryChildren : [],
    cardPaid: cardAmount,
    passesUsed,
    freeVisit: !!freeVisitCard,
    freeVisitMessage: freeVisitCard
      ? "📋 That was the last visit on your prepaid card — it's now complete. That card type has been retired, so you're on our free Loyalty Punch Card program going forward: just book online like normal, and every 8th visit is on us."
      : "",
    birthdayAmount,
    birthdayNames: birthdayApplied.map(b => b.childName),
    birthdayMessage: birthdayApplied.length
      ? `🎂 Happy birthday ${birthdayApplied.map(b => b.childName).join(" & ")}! Their free admission is on us today.`
      : "",
    birthdayWarnings,
    adults: totalAdults,
    additionalAdults,
    remaining: Math.max(0, cap - (current + children)),
    paymentId: payment?.id || null,
  });
};

// Charges a single payment source (a card token or a gift card id) via Square.
// A STABLE idempotency key per logical charge. Square de-duplicates on this key,
// so a browser retry, a double-tap, or a function re-invocation after a timeout
// returns the ORIGINAL payment instead of charging the customer twice. The old
// random UUID defeated that completely. Anything real about the charge changing
// (amount, date, slot, buyer) yields a different key, so a genuinely different
// booking is never wrongly de-duplicated.
function idemKey(parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 45);
}

// Reverses payments already taken in this request when a later leg fails, so a
// customer is never left charged for a booking that was not created. Best effort:
// anything that can't be refunded automatically is emailed to the studio.
async function refundAll(env, taken) {
  for (const p of taken || []) {
    if (!p || !p.id) continue;
    try {
      const res = await fetch(`${squareApiBase()}/v2/refunds`, {
        method: "POST",
        headers: {
          "Square-Version": SQUARE_VERSION,
          "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: idemKey(["refund", p.id]),
          payment_id: p.id,
          amount_money: p.amount_money,
          reason: "Booking could not be completed",
        }),
      });
      if (!res.ok) throw new Error("refund rejected");
    } catch (e) {
      try {
        await sendOwnerAlert(
          "🚨 Refund needed — payment taken but booking failed",
          `<h3>A payment went through but the booking did not</h3>
           <p>Square payment <b>${p.id}</b> for <b>$${((p.amount_money?.amount || 0) / 100).toFixed(2)}</b>
           could not be refunded automatically. Please refund it by hand in the Square dashboard.</p>`
        );
      } catch {}
    }
  }
}

async function chargeSquare(env, { source_id, amount, note, email, idem }) {
  const body = {
    idempotency_key: idem || crypto.randomUUID(),
    source_id,
    amount_money: { amount, currency: "USD" },
    location_id: env.SQUARE_LOCATION_ID,
    autocomplete: true,
    note,
    buyer_email_address: email || undefined,
  };
  const res = await fetch(`${squareApiBase()}/v2/payments`, {
    method: "POST",
    headers: {
      "Square-Version": SQUARE_VERSION,
      "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    return { ok: false, detail: data?.errors?.[0]?.detail || "Payment was declined." };
  }
  return { ok: true, payment: data.payment };
}

// Logs a free-visit/birthday/classroom code that failed to redeem at checkout, and
// emails the studio right away with who tried and why — so a family that got stuck
// can be followed up with instead of just quietly walking away. Fire-and-forget:
// never blocks or fails the actual booking-error response it's attached to.
async function logFailedCode({ code, reason, name, email, phone }) {
  const at = new Date().toISOString();
  try {
    const store = getStore("failed-redemptions");
    const id = at.replace(/[^0-9]/g, "") + "-" + Math.random().toString(36).slice(2, 6);
    await store.setJSON("fail:" + id, { code, reason, name, email, phone, at });
  } catch {}
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    await sendOwnerAlert(
      `⚠️ A code failed at checkout: ${code}`,
      `<h3>A free-visit code didn't redeem</h3>
       <p><b>Code:</b> ${esc(code)}<br><b>Reason:</b> ${esc(reason)}</p>
       <p><b>Who tried it:</b><br>Name: ${esc(name) || "—"}<br>Email: ${esc(email) || "—"}<br>Phone: ${esc(phone) || "—"}</p>
       <p style="color:#8a8276;font-size:13px">Logged ${esc(at)}. You can look this code up or re-issue it from Staff/Admin → Codes ledger.</p>`
    );
  } catch {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function dollars(cents) { return "$" + (cents / 100).toFixed(2); }

// Optional child birthday, stored as yyyy-mm-dd. Returns "" if missing or invalid.
function validDob(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return "";
  const yr = +m[1], mo = +m[2], da = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || yr < 1900) return "";
  const dt = new Date(Date.UTC(yr, mo - 1, da));
  if (dt.getUTCFullYear() !== yr || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) return "";
  if (s > new Date().toISOString().slice(0, 10)) return "";
  return s;
}

// Sends the customer a confirmation + policy email via Resend.
// If RESEND_API_KEY isn't set, this quietly does nothing.
async function sendConfirmation({ email, name, date, slotLabel, regular, sibling, infant, adults = 0, additionalAdults = 0, coveredRegular = 0, coveredInfant = 0, paidRegular = regular, paidInfant = infant, subtotal, tax, amount, giftApplied = [], giftTotal = 0, creditApplied = 0, creditRemaining = null, cardAmount = 0, passesUsed = [], discountPct = 0, discountAmount = 0, weekdaySpecialAmount = 0, weekdaySpecialLabel = "", militaryAmount = 0, militaryChildren = [], loyaltyCards = [] }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !email) return;

  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;

  const lines = [];
  if (regular) lines.push(`${regular} × Regular admission (18 months+)${coveredRegular ? ` — ${coveredRegular} covered by pass` : ""}`);
  if (sibling) lines.push(`${sibling} × Sibling add-on (18 months+)`);
  if (infant)  lines.push(`${infant} × Baby/Infant admission (6-17 months)${coveredInfant ? ` — ${coveredInfant} covered by pass` : ""}`);
  if (additionalAdults)  lines.push(`${additionalAdults} × Additional adult`);
  const total = regular + sibling + infant;

  // Punch card rows (visits remaining after this booking)
  const passLines = passesUsed.map(p =>
    `<tr><td style="padding:2px 0;color:#5c6470">Prepaid pass ${p.code} used (1 visit)</td><td style="padding:2px 0;text-align:right;font-weight:bold">${p.total ? `${p.visitsRemaining} of ${p.total} left` : `${p.visitsRemaining} left`}</td></tr>`
  ).join("");

  // Combined punch-card section — folds the old separate "welcome" email into this one.
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const anyNew = loyaltyCards.some(c => c.isNew);
  const cardRows = loyaltyCards.map(c =>
    `<tr><td style="padding:6px 9px;border-top:1px solid #e6eee2"><b>${esc(c.childName)}</b></td>`
    + `<td style="padding:6px 9px;border-top:1px solid #e6eee2;text-align:center;font-family:monospace;font-weight:bold;color:#a85f59;letter-spacing:1px">${esc(c.code)}</td>`
    + `<td style="padding:6px 9px;border-top:1px solid #e6eee2;text-align:right;color:#5c6470">${c.punches}/${c.needed} visits</td></tr>`
  ).join("");
  const loyaltySection = loyaltyCards.length ? `
    <div style="background:#f3f7f2;border-radius:14px;padding:16px 18px;margin:20px 0">
      <h3 style="margin:0 0 6px;color:#5f8060;font-weight:bold;font-size:15px">Your punch card${loyaltyCards.length > 1 ? "s" : ""} 🎈</h3>
      <p style="margin:0 0 10px;font-size:14px;color:#5c6470">${anyNew
        ? `Here ${loyaltyCards.length > 1 ? "are your codes" : "is your code"} — next time, enter ${loyaltyCards.length > 1 ? "a code" : "it"} on the booking page to <b>auto-fill your child's information</b> and book faster.`
        : `Enter your code on the booking page next time to <b>auto-fill your child's information</b> and book faster.`}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:0 9px 4px;color:#8a8276;font-size:12px">Child</td><td style="padding:0 9px 4px;text-align:center;color:#8a8276;font-size:12px">Code</td><td style="padding:0 9px 4px;text-align:right;color:#8a8276;font-size:12px">Progress</td></tr>
        ${cardRows}
      </table>
      <p style="margin:10px 0 0;font-size:13px;color:#5c6470">We keep track of your visits automatically — after 7 visits each, the 8th is free. Nothing else to do! 💛</p>
    </div>` : "";

  // Payment breakdown rows (shown when a gift card or store credit was used)
  let payRows = `<tr><td style="padding:6px 0 0;color:#5c6470">Total paid</td><td style="padding:6px 0 0;text-align:right;font-weight:bold;font-size:18px;color:#7ba676">${dollars(amount)}</td></tr>`;
  if (giftTotal > 0 || creditApplied > 0) {
    const gcLines = giftApplied.map(g =>
      `<tr><td style="padding:2px 0;color:#5c6470">Gift card ${g.gan}${g.balanceAfter != null ? ` (balance left: ${dollars(g.balanceAfter)})` : ""}</td><td style="padding:2px 0;text-align:right;font-weight:bold">−${dollars(g.applied)}</td></tr>`
    ).join("");
    const creditLine = creditApplied > 0
      ? `<tr><td style="padding:2px 0;color:#5c6470">Store credit${creditRemaining != null ? ` (balance left: ${dollars(creditRemaining)})` : ""}</td><td style="padding:2px 0;text-align:right;font-weight:bold">−${dollars(creditApplied)}</td></tr>` : "";
    payRows = `<tr><td style="padding:6px 0 2px;color:#5c6470">Total</td><td style="padding:6px 0 2px;text-align:right;font-weight:bold">${dollars(amount)}</td></tr>`
      + gcLines + creditLine
      + `<tr><td style="padding:6px 0 0;color:#5c6470">Paid by card</td><td style="padding:6px 0 0;text-align:right;font-weight:bold;font-size:18px;color:#7ba676">${dollars(cardAmount)}</td></tr>`;
  }

  const policyHtml = POLICY_LINES.map(l => `<li style="margin:0 0 6px">${l}</li>`).join("");
  const waiverUrl = process.env.WAIVER_URL || "https://waivermaster.com/sign.html?q=DU3F7C23VNX8D";

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:0 auto;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">Your reservation is confirmed 🌿</h2>
    <p style="margin:0 0 16px;color:#5c6470">Thank you${name ? ", " + name : ""} — your reservation is confirmed and we can't wait to welcome you to ${STUDIO_NAME}. Here are your details:</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <tr><td style="padding:6px 0;color:#5c6470">Date</td><td style="padding:6px 0;text-align:right;font-weight:bold">${date}</td></tr>
      <tr><td style="padding:6px 0;color:#5c6470">Session</td><td style="padding:6px 0;text-align:right;font-weight:bold">${slotLabel}</td></tr>
      <tr><td colspan="2" style="padding:2px 0 6px;color:#8a8276;font-size:12px">💛 No need to rush — your 2 hours start when you arrive. The session times just help us manage space, so a few minutes late is always okay.</td></tr>
      <tr><td style="padding:6px 0;color:#5c6470">Children</td><td style="padding:6px 0;text-align:right;font-weight:bold">${total}</td></tr>
      <tr><td style="padding:6px 0;color:#5c6470">Admissions</td><td style="padding:6px 0;text-align:right;font-weight:bold">${lines.join("<br>")}</td></tr>
      ${passLines}
      <tr><td style="padding:10px 0 2px;color:#5c6470">Subtotal</td><td style="padding:10px 0 2px;text-align:right;font-weight:bold">${dollars(subtotal)}</td></tr>
      ${discountAmount > 0 ? `<tr><td style="padding:2px 0;color:#7ba676">Discount (${discountPct}% off)</td><td style="padding:2px 0;text-align:right;font-weight:bold;color:#7ba676">−${dollars(discountAmount)}</td></tr>` : ""}
      ${weekdaySpecialAmount > 0 ? `<tr><td style="padding:2px 0;color:#7ba676">🗓️ ${weekdaySpecialLabel}</td><td style="padding:2px 0;text-align:right;font-weight:bold;color:#7ba676">−${dollars(weekdaySpecialAmount)}</td></tr>` : ""}
      ${militaryAmount > 0 ? `<tr><td style="padding:2px 0;color:#7ba676">🎖️ Military discount (10% off)</td><td style="padding:2px 0;text-align:right;font-weight:bold;color:#7ba676">−${dollars(militaryAmount)}</td></tr>` : ""}
      ${payRows}
    </table>
    ${loyaltySection}

    <div style="background:#fdf1ec;border-radius:14px;padding:16px 18px;margin:20px 0">
      <h3 style="margin:0 0 8px;color:#a85f59;font-weight:bold;font-size:15px">One quick thing before you arrive — your waiver 💛</h3>
      <p style="margin:0 0 10px;font-size:14px;color:#5c6470">A signed waiver is required for every visit, and it stays valid for <b>365 days</b> from the date it was first signed.</p>
      <ul style="margin:0 0 12px;padding-left:18px;font-size:14px;color:#5c6470">
        <li style="margin:0 0 6px">If you're the parent or guardian who signed within the last year, you're all set — no need to sign again.</li>
        <li style="margin:0 0 6px">If you've never signed with us, or a different parent or guardian is bringing the child(ren) this time, we'll simply need a fresh waiver from whoever is accompanying them that day.</li>
      </ul>
      <a href="${waiverUrl}" style="display:inline-block;background:#c97d76;color:#fff;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:.04em;text-transform:uppercase;padding:11px 22px;border-radius:40px">Sign your waiver</a>
    </div>

    <hr style="border:none;border-top:1px solid #efe7da;margin:18px 0">
    <h3 style="margin:0 0 8px;font-size:14px;color:#2a2622">${POLICY_TITLE}</h3>
    <ul style="margin:0;padding-left:18px;font-size:13px;color:#8a8276">${policyHtml}</ul>
    <p style="margin:18px 0 0;font-size:13px;color:#aea298">We can't wait to see you at ${STUDIO_NAME}! 💛</p>
    <p style="margin:14px 0 0;background:#fcfaf6;border:1px solid #efe7da;border-radius:10px;padding:11px 13px;font-size:13px;color:#5c6470"><b>📩 Don't see this email?</b> Please check your junk/spam folder and mark it "not spam" so you receive future confirmations.</p>
  </div>`;

  const cardText = loyaltyCards.length
    ? `YOUR PUNCH CARD${loyaltyCards.length > 1 ? "S" : ""}\n`
      + loyaltyCards.map(c => `- ${c.childName}: ${c.code} (${c.punches}/${c.needed} visits)`).join("\n")
      + `\nEnter your code on the booking page next time to auto-fill your child's information and book faster. We track your visits automatically — after 7 visits each, the 8th is free.\n\n`
    : "";
  const text = `Your ${STUDIO_NAME} reservation is confirmed!\n\n`
    + `Date: ${date}\nSession: ${slotLabel}\nChildren: ${total}\n`
    + `Admissions: ${lines.join(", ")}\nSubtotal: ${dollars(subtotal)}\nTotal paid: ${dollars(amount)}\n\n`
    + cardText
    + `YOUR WAIVER\nA signed waiver is required for every visit and stays valid for 365 days from the date it was first signed.\n`
    + `- If you're the parent/guardian who signed within the last year, you're all set.\n`
    + `- If you've never signed, or a different parent/guardian is bringing the child(ren) this time, please sign a fresh waiver.\n`
    + `Sign here: ${waiverUrl}\n\n`
    + `${POLICY_TITLE}\n` + POLICY_LINES.map(l => "- " + l).join("\n")
    + `\n\nWe can't wait to see you at ${STUDIO_NAME}!`;

  await resendEmail({
    from: `${STUDIO_NAME} <${from}>`,
    to: [email],
    bcc: bcc ? [bcc] : undefined,
    subject: `Your ${STUDIO_NAME} reservation is confirmed${loyaltyCards.length ? ` + punch card code${loyaltyCards.length > 1 ? "s" : ""}` : ""} 🎈 — ${date}`,
    html, text,
  });
}

export const config = { path: "/api/book" };
