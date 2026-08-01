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
import { SIGNATURE_HTML, sendOwnerAlert } from "./lib-email.js";
import {
  CAPACITY, PRICES, pricesFor, SLOTS, SLOT_IDS, openPlayForDate, effectivePartyBlocks, hoursFor, slotCap, slotKey, arrivalStartMin, squareApiBase, SQUARE_VERSION, BOOKING_WINDOW_DAYS,
  PARTY_SLOT_IDS, ARRIVAL_TO_LEGACY,
  STUDIO_NAME, POLICY_TITLE, POLICY_LINES, CLOSED_DATES, CLOSED_MESSAGE, ADDITIONAL_ADULT, isClosedWeekday, weekdayOf,
  additionalAdultsFor, additionalAdultCentsFor,
} from "./lib-settings.js";
import { issueCode, sendWelcome, sendFamilyPunch, PUNCHES_FOR_REWARD, cleanName, last4 as loyaltyLast4, graduateLegacyCard } from "./lib-loyalty.js";
import { loadSeasonal, loadWeekly } from "./lib-hours.js";
import { getClosure, slotBlockedByClosure } from "./lib-closures.js";
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
  if (slotBlockedByClosure(_closure, slot))
    return json({ error: "closed", message: (_closure && _closure.note) || "We're closed for that time." }, 409);
  if (!SLOT_IDS.includes(slot))         return json({ error: "Invalid time slot." }, 400);
  // Open play can only be booked within the rolling window (default 2 weeks).
  const maxStr = new Date(Date.now() + (BOOKING_WINDOW_DAYS + 1) * 86400000).toISOString().slice(0, 10);
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
    if (!prec.active || prec.visitsRemaining < 1)
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
    if (discRec.used || !discRec.active)            return json({ error: "discount", message: `Discount code ${discountCode} has already been used.` }, 409);
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
  if (rewardCode) {
    if (discountCode) return json({ error: "reward", message: "A free-visit reward can't be combined with a discount code." }, 409);
    if (hasStoreCredit) return json({ error: "reward", message: "A free-visit reward can't be combined with store credit." }, 409);
    const today2 = new Date().toISOString().slice(0, 10);
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
    if (rewardRec.validFrom && today2 < rewardRec.validFrom) {
      await logFailedCode({ code: rewardCode, reason: `not valid until ${rewardRec.validFrom}`, name, email, phone });
      return json({ error: "reward", message: rewardRec.kind === "birthday"
        ? `🎂 This birthday gift can be used on ${rewardRec.validFrom} — see you then!`
        : `Free-visit code ${rewardCode} isn't valid until ${rewardRec.validFrom}.` }, 409);
    }
    if (rewardRec.expiry && rewardRec.expiry < today2) {
      await logFailedCode({ code: rewardCode, reason: `expired ${rewardRec.expiry}`, name, email, phone });
      return json({ error: "reward", message: rewardRec.kind === "birthday"
        ? `🎂 This birthday gift was good on ${rewardRec.expiry} only and has expired.`
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
    const today2 = new Date().toISOString().slice(0, 10);
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
      if (r.validFrom && today2 < r.validFrom) {
        await logFailedCode({ code: bc, reason: `not valid until ${r.validFrom}`, name, email, phone });
        return json({ error: "reward", message: `🎂 Birthday code ${bc} can be used on ${r.validFrom} — see you then!` }, 409);
      }
      if (r.expiry && r.expiry < today2) {
        await logFailedCode({ code: bc, reason: `expired ${r.expiry}`, name, email, phone });
        return json({ error: "reward", message: `🎂 Birthday code ${bc} was good on ${r.expiry} only and has expired.` }, 409);
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

  const taxable = Math.max(0, subtotal - discountAmount - weekdaySpecialAmount - militaryAmount - rewardAmount - birthdayAmount);
  // No sales tax: recreational/amusement admission is CDTFA-exempt (intangible admission),
  // so this business does not collect sales tax on any admission, party, or gift card sale.
  const tax = 0;
  const amount = taxable;                        // total due (may be $0 if fully covered)

  const store = getStore("bookings");
  const key = slotKey(date, slot);

  // Reserved for a private party?
  try {
    const blocked = await getStore("blocks").get(key, { type: "json" });
    if (blocked) return json({ error: "reserved", message: "That session is reserved for a private party." }, 409);
  } catch {}

  // Capacity check (read current count). Existing bookings under the OLD session
  // that maps to this arrival time count too, so the room is never oversold.
  let rec = null;
  try { rec = await store.get(key, { type: "json" }); } catch { rec = null; }
  let current = rec && typeof rec.children === "number" ? rec.children : 0;
  for (const legacy of (ARRIVAL_TO_LEGACY[slot] || [])) {
    try { const lr = await store.get(slotKey(date, legacy), { type: "json" }); if (lr && typeof lr.children === "number") current += lr.children; } catch {}
  }
  if (current + children > cap) {
    const remaining = Math.max(0, cap - current);
    return json({ error: "full", remaining,
      message: `Only ${remaining} spot${remaining === 1 ? "" : "s"} left in that session.` }, 409);
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
    if (!creditRec.active || creditRec.amount < 1)
      return json({ error: "promo", message: `Promo code ${promoCode} has no balance left.` }, 409);
    creditApplied = Math.min(due, creditRec.amount);
    due -= creditApplied;
  }

  const cardAmount = due;   // remainder to charge to the credit card
  if (cardAmount > 0 && !sourceId) {
    return json({ error: "card_required", message: "A card is needed for the remaining balance." }, 400);
  }

  // Process payments: credit card first (the part most likely to fail), then redeem gift cards.
  const payments = [];
  try {
    if (cardAmount > 0) {
      const p = await chargeSquare(env, { source_id: sourceId, amount: cardAmount, note, email });
      if (!p.ok) return json({ error: "payment_failed", message: p.detail }, 402);
      payments.push(p.payment);
    }
    for (const g of giftApplied) {
      const p = await chargeSquare(env, { source_id: g.id, amount: g.applied, note, email });
      if (!p.ok) return json({ error: "giftcard", message: `Couldn't redeem gift card ${g.gan}.` }, 402);
      payments.push(p.payment);
      g.balanceAfter = p.giftCardBalance;
    }
  } catch (e) {
    return json({ error: "payment_error", message: "Could not reach the payment processor." }, 502);
  }
  const payment = payments[0] || null;

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
    passesUsed.push({ code: up.code, admission: up.admission, visitsRemaining: after, freeVisit: after === 0 });
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

  // Record the booking (re-read to reduce the chance of a stale write)
  let latest = null;
  try { latest = await store.get(key, { type: "json" }); } catch { latest = null; }
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
    discountCode: discountAmount > 0 ? discountCode : null, discountPct, discountAmount,
    weekdaySpecialAmount, weekdaySpecialLabel: weekdaySpecialAmount > 0 ? weekdaySpecialLabel : "",
    militaryAmount, militaryChildren: militaryAmount > 0 ? militaryChildren : [],
    passesUsed,
    paymentId: payment?.id || null,
    at: new Date().toISOString(),
  });
  base.children = (base.children || 0) + children;

  try { await store.setJSON(key, base); }
  catch { /* payment already succeeded; surface success anyway */ }

  // ---- Loyalty punch card: auto-issue each child's code + welcome email at booking.
  // Skipped entirely when a legacy prepaid card was used (legacy never joins loyalty
  // for that visit). The actual PUNCH happens later, at check-in (see arrivals.js).
  const phone4 = loyaltyLast4(phone);
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
    // Send ONE combined welcome email for the whole family (never one per child).
    const newCards = issued.filter(r => r && r.isNew);
    if (email && newCards.length) {
      try {
        if (newCards.length === 1) { await sendWelcome(newCards[0].rec); }
        else { await sendFamilyPunch(email, newCards.map(c => ({ childName: c.childName, code: c.code, punches: 0, needed: PUNCHES_FOR_REWARD, rewardIssued: false }))); }
      } catch {}
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
      giftApplied, giftTotal, creditApplied, creditRemaining, cardAmount, passesUsed, discountPct, discountAmount, weekdaySpecialAmount, weekdaySpecialLabel, militaryAmount, militaryChildren });
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
    remaining: Math.max(0, cap - base.children),
    paymentId: payment?.id || null,
  });
};

// Charges a single payment source (a card token or a gift card id) via Square.
async function chargeSquare(env, { source_id, amount, note, email }) {
  const body = {
    idempotency_key: crypto.randomUUID(),
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
async function sendConfirmation({ email, name, date, slotLabel, regular, sibling, infant, adults = 0, additionalAdults = 0, coveredRegular = 0, coveredInfant = 0, paidRegular = regular, paidInfant = infant, subtotal, tax, amount, giftApplied = [], giftTotal = 0, creditApplied = 0, creditRemaining = null, cardAmount = 0, passesUsed = [], discountPct = 0, discountAmount = 0, weekdaySpecialAmount = 0, weekdaySpecialLabel = "", militaryAmount = 0, militaryChildren = [] }) {
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
    `<tr><td style="padding:2px 0;color:#5c6470">Pass ${p.code} used (1 visit)</td><td style="padding:2px 0;text-align:right;font-weight:bold">${p.visitsRemaining} left</td></tr>`
  ).join("");

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
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">Your booking is confirmed 🌿</h2>
    <p style="margin:0 0 16px;color:#5c6470">Thank you${name ? ", " + name : ""} — we can't wait to welcome you to ${STUDIO_NAME}. Here are your details:</p>
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

  const text = `Your ${STUDIO_NAME} booking is confirmed!\n\n`
    + `Date: ${date}\nSession: ${slotLabel}\nChildren: ${total}\n`
    + `Admissions: ${lines.join(", ")}\nSubtotal: ${dollars(subtotal)}\nTotal paid: ${dollars(amount)}\n\n`
    + `YOUR WAIVER\nA signed waiver is required for every visit and stays valid for 365 days from the date it was first signed.\n`
    + `- If you're the parent/guardian who signed within the last year, you're all set.\n`
    + `- If you've never signed, or a different parent/guardian is bringing the child(ren) this time, please sign a fresh waiver.\n`
    + `Sign here: ${waiverUrl}\n\n`
    + `${POLICY_TITLE}\n` + POLICY_LINES.map(l => "- " + l).join("\n")
    + `\n\nWe can't wait to see you at ${STUDIO_NAME}!`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${STUDIO_NAME} <${from}>`,
      to: [email],
      bcc: bcc ? [bcc] : undefined,
      subject: `Your ${STUDIO_NAME} booking is confirmed — ${date}`,
      html, text,
    }),
  });
}

export const config = { path: "/api/book" };
