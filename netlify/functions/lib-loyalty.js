// Child profiles ("cards" in the loyalty store), used by loyalty.js (staff tool),
// book.js (a profile for each child at booking) and arrivals.js (visit history).
//
// The "7 visits, 8th free" punch program has ENDED (Oct 2026). Profiles are still
// created for every child (records, newsletter, Play Club, birthdays, military), but:
//   - no punches are added and no free-visit rewards are earned,
//   - no welcome / punch / reward emails are sent.
// Existing cards keep their codes and old punch counts untouched. Free-visit codes
// already emailed before the change still work when booking.
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML, fromHeader, TERMS, reviewRequestHtml } from "./lib-email.js";

export const PUNCHES_ENABLED = false;    // punch program ended — see top of file
export const PUNCHES_FOR_REWARD = 7;      // kept only for old records
export const REWARD_EXPIRY_DAYS = 30;
const REWARD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function cleanName(first, last) {
  return [String(first || "").trim(), String(last || "").trim()].filter(Boolean).join(" ");
}
// Normalizes a name for MATCHING ONLY (never for display): lowercases and treats any
// run of non-alphanumeric characters — dashes, apostrophes, periods, extra spaces —
// as a single space. So "Henry-Mitchell" and "Henry Mitchell" (or "O'Brien"/"O Brien")
// resolve to the SAME existing card instead of creating a duplicate.
export function nameKey(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim(); }
export function last4(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : "";
}
export function normalizeCode(c) { return (c || "").toString().trim().toUpperCase().replace(/[^A-Z0-9-]/g, ""); }

// Records one visit onto a child's card. Called from inside issueCode/addPunch
// whenever a caller passes visitMeta — callers that AREN'T a real visit (e.g.
// issuing a card at booking time, before the child has actually shown up, or
// graduating a legacy card holder) simply don't pass visitMeta, and nothing
// gets logged. This is the ONLY place a visit gets written, so every path that
// results in a punch or a free admission — online check-in, a manual walk-in
// punch — records history the same way, with no gaps between them.
async function pushVisit(loyalty, code, visitMeta, freeAdmission) {
  if (!code || !visitMeta) return;
  try {
    let card = await loyalty.get("card:" + code, { type: "json" });
    if (!card) return;
    card.visits = Array.isArray(card.visits) ? card.visits : [];
    card.visits.unshift({
      date: visitMeta.date || pacificToday(), at: new Date().toISOString(),
      slotLabel: visitMeta.slotLabel || "", admission: visitMeta.admission || "regular",
      freeAdmission: !!freeAdmission,
      discountCode: visitMeta.discountCode || null, discountPct: visitMeta.discountPct || 0,
      weekdaySpecialLabel: visitMeta.weekdaySpecialLabel || "", military: !!visitMeta.military,
      bookingId: visitMeta.bookingId || null, source: visitMeta.source || "online",
    });
    card.visits = card.visits.slice(0, 200);
    await loyalty.setJSON("card:" + code, card);
  } catch {}
}
function pacificToday() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }

// Resolve a child's card. Default code = first+last initial + last4 (RR4655); on a
// same-initials sibling collision, use more letters of the first name (RER4655, …).
// findOnly=true never returns a fresh slot (used for read-only lookups).
export async function resolveCard(loyalty, first, last, phone4, findOnly = false) {
  const li = (String(last).trim()[0] || "X").toUpperCase();
  const fn = String(first).trim();
  const target = nameKey(cleanName(first, last));
  const maxLen = Math.min(Math.max(fn.length, 1), 8);

  // Every read here uses strong consistency deliberately — this function decides
  // which code a NEW card gets, so it must always see the truly latest state, not
  // a possibly-stale cached copy. A stale read here was the actual root cause of
  // two siblings with the same initials (e.g. Victoria and Vincente) ending up
  // assigned the identical code: sibling B's check for "is the short code already
  // taken?" briefly still said no right after sibling A's card was saved, so B got
  // the same code and silently overwrote A's card on save. Strong consistency
  // closes that window.

  // Pass 1 — search EVERY base-length code for THIS child's existing card first.
  // (Don't stop at the first empty slot; the child's card may live at a longer code
  //  because shorter ones are taken by other children sharing the phone.)
  let firstEmpty = null;
  for (let len = 1; len <= maxLen; len++) {
    const code = (fn.slice(0, len).toUpperCase() + li + phone4).replace(/[^A-Z0-9]/g, "");
    let rec = null;
    try { rec = await loyalty.get("card:" + code, { type: "json", consistency: "strong" }); } catch { rec = null; }
    if (!rec) { if (firstEmpty === null) firstEmpty = code; continue; }
    const onFile = nameKey(rec.childName);
    if (onFile === target) return { code, rec };
  }

  // Pass 2 — search the -n overflow codes for an existing match.
  const base = (fn.toUpperCase() + li + phone4).replace(/[^A-Z0-9]/g, "");
  let firstEmptySuffix = null;
  for (let n = 2; n <= 20; n++) {
    const code = base + "-" + n;
    let rec = null;
    try { rec = await loyalty.get("card:" + code, { type: "json", consistency: "strong" }); } catch { rec = null; }
    if (!rec) { if (firstEmptySuffix === null) firstEmptySuffix = code; continue; }
    const onFile = nameKey(rec.childName);
    if (onFile === target) return { code, rec };
  }

  // No existing card found anywhere.
  if (findOnly) return { code: null, rec: null };

  // Hand back the best candidate — but as a hard safety net, re-verify it's
  // genuinely empty right before handing it off, one more strong-consistency
  // check. If something is unexpectedly there now (another request beat us to
  // it a split second ago), walk forward to the next candidate instead of ever
  // returning a code that would overwrite an existing card.
  const candidates = [];
  if (firstEmpty) candidates.push(firstEmpty);
  for (let len = 1; len <= maxLen; len++) {
    const c = (fn.slice(0, len).toUpperCase() + li + phone4).replace(/[^A-Z0-9]/g, "");
    if (!candidates.includes(c)) candidates.push(c);
  }
  if (firstEmptySuffix) candidates.push(firstEmptySuffix);
  for (let n = 2; n <= 20; n++) candidates.push(base + "-" + n);

  for (const code of candidates) {
    let rec = null;
    try { rec = await loyalty.get("card:" + code, { type: "json", consistency: "strong" }); } catch { rec = null; }
    if (!rec) return { code, rec: null };
  }
  return { code: base + "-" + Date.now().toString(36).slice(-4).toUpperCase(), rec: null };
}

// True if a code belongs to a legacy pre-paid punch card (those never earn loyalty punches).
export async function isLegacyPassCode(code) {
  const c = normalizeCode(code);
  if (!c) return false;
  try {
    const rec = await getStore("passes").get("pass:" + c, { type: "json" });
    return !!rec;
  } catch { return false; }
}

// Find or create a child's profile (no visit counted, no email). Returns { code, isNew }.
export async function issueCode(loyalty, { first, last, phone4, email, dob, suppressEmail, visitMeta }) {
  const { code, rec } = await resolveCard(loyalty, first, last, phone4, false);
  if (rec) {
    let changed = false;
    if (email && !rec.buyerEmail) { rec.buyerEmail = email; changed = true; }
    if (dob && !rec.dob) { rec.dob = dob; changed = true; }
    if (changed) { try { await loyalty.setJSON("card:" + code, rec); } catch {} }
    if (visitMeta) await pushVisit(loyalty, code, visitMeta, true);
    return { code, isNew: false, childName: rec.childName };
  }
  const now = new Date();
  const fresh = { code, childName: cleanName(first, last), phone4, punches: 0, rewardsEarned: 0, totalVisits: 0,
    createdAt: now.toISOString(), history: [{ at: now.toISOString(), action: "issued" }], buyerEmail: (email || "").trim(),
    dob: (dob || "").trim() || undefined };
  try { await loyalty.setJSON("card:" + code, fresh); } catch {}
  if (visitMeta) await pushVisit(loyalty, code, visitMeta, true);
  return { code, isNew: true, childName: fresh.childName, rec: fresh };
}

// Record ONE visit on a child's profile (creates the profile if new). Punches and
// free-visit rewards only happen while PUNCHES_ENABLED is on (it's off). No emails.
// noPunch: record the visit and everything else, but DON'T advance the loyalty
// count. Used for a free birthday admission — the child was here, so it belongs
// in their visit history, but a free visit shouldn't earn progress toward another
// free visit.
export async function addPunch(loyalty, { first, last, phone4, email, code: directCode, suppressEmail, waiverSigned, adultNames, militaryVerified, dob, visitMeta, noPunch, birthdayYear, createOnly }) {
  let code, existing;
  if (directCode) {
    code = normalizeCode(directCode);
    try { existing = await loyalty.get("card:" + code, { type: "json" }); } catch { existing = null; }
  } else {
    ({ code, rec: existing } = await resolveCard(loyalty, first, last, phone4, false));
  }
  let rec = existing, isNew = false;
  if (!rec) {
    // Final hard safety net: re-check this exact code, strong-consistency, one
    // more time right before committing to it as a NEW card. resolveCard already
    // does this, but re-checking here too — right at the moment of creation,
    // after any other work this function did in between — makes it structurally
    // impossible for this function to silently overwrite an existing card no
    // matter what changed in the moments in between.
    let doubleCheck = null;
    try { doubleCheck = await loyalty.get("card:" + code, { type: "json", consistency: "strong" }); } catch {}
    if (doubleCheck) {
      return { error: true, collision: true,
        message: `Code ${code} was just taken by another card (${doubleCheck.childName || "unknown"}) — try again, a new code will be assigned.` };
    }
    isNew = true;
    rec = { code, childName: cleanName(first, last), phone4, punches: 0, rewardsEarned: 0, totalVisits: 0,
      createdAt: new Date().toISOString(), history: [], buyerEmail: (email || "").trim() };
  } else if (email && !rec.buyerEmail) { rec.buyerEmail = email; }
  if (dob && /^\d{4}-\d{2}-\d{2}$/.test(dob) && !rec.dob) rec.dob = dob;

  // Saved on the SAME record write as the punch, whether the card is brand new or
  // already existed — avoids the old two-step flow where a separate waiver save
  // could run before a freshly-created card was findable yet.
  if (waiverSigned && /^\d{4}-\d{2}-\d{2}$/.test(waiverSigned)) {
    rec.waiverSigned = waiverSigned;
    const exp = new Date(waiverSigned + "T12:00:00"); exp.setDate(exp.getDate() + 365);
    rec.waiverExpiry = exp.toISOString().slice(0, 10);
  }
  if (Array.isArray(adultNames) && adultNames.length) {
    const signedDate = (waiverSigned && /^\d{4}-\d{2}-\d{2}$/.test(waiverSigned)) ? waiverSigned : "";
    const expiry = rec.waiverExpiry || "";
    const existingAdults = Array.isArray(rec.waiverAdults) ? rec.waiverAdults : [];
    // Dedupe against the names already on file AND against duplicates inside this
    // same submission — otherwise checking one adult in twice files them twice
    // ("Alesha Kee, Alesha Kee"), since neither copy is on the card yet.
    const seen = new Set(existingAdults.map(a => (a.name || "").toLowerCase().trim()));
    const newAdults = [];
    for (const raw of adultNames) {
      const n = (raw || "").toString().slice(0, 80).trim();
      if (!n) continue;
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      newAdults.push({ name: n, signedDate, expiry });
    }
    rec.waiverAdults = existingAdults.concat(newAdults).slice(0, 20);
  }
  if (militaryVerified === true && !rec.militaryVerified) {
    rec.militaryVerified = true;
    rec.history = Array.isArray(rec.history) ? rec.history : [];
    rec.history.push({ at: new Date().toISOString(), action: "military-verified" });
  }

  // createOnly: staff just want the card on file (e.g. a new Play Club member) —
  // no punch, no visit, no email. Saves the card and returns.
  if (createOnly) {
    rec.history = Array.isArray(rec.history) ? rec.history : [];
    if (isNew) rec.history.push({ at: new Date().toISOString(), action: "created", source: "staff" });
    try { await loyalty.setJSON("card:" + code, rec); } catch { return { error: true }; }
    return { code, childName: rec.childName, isNew, punches: rec.punches || 0, needed: PUNCHES_FOR_REWARD, created: true,
      rewardIssued: false, militaryVerified: !!rec.militaryVerified };
  }

  // Every visit is recorded. Punches only advance while the punch program is on
  // (it's off now), and never for a free birthday admission.
  const punch = PUNCHES_ENABLED && !noPunch;
  if (punch) rec.punches = (rec.punches || 0) + 1;
  rec.totalVisits = (rec.totalVisits || 0) + 1;
  rec.lastVisit = new Date().toISOString();
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  const via = (visitMeta && visitMeta.source) || "manual";
  rec.history.push(noPunch
    ? { at: rec.lastVisit, action: "birthday-visit", punches: rec.punches || 0, source: via,
        note: "Free birthday admission — no punch" }
    : { at: rec.lastVisit, action: punch ? "punch" : "visit", ...(punch ? { punches: rec.punches } : {}), source: via,
        note: via === "walkin" ? "Walk-in visit" : undefined });

  // Stamp the birthday as used for this year so neither cron pass emails another
  // code. Mirrors what the manual issue buttons write.
  if (birthdayYear) {
    rec.lastSentYear = birthdayYear;
    rec.dayOfSentYear = birthdayYear;
    rec.birthdayUsedYear = birthdayYear;
    rec.birthdayUsedAt = rec.lastVisit;
  }

  let rewardIssued = null;
  if (punch && rec.punches >= PUNCHES_FOR_REWARD) {
    const rewards = getStore("rewards");
    const rewardCode = await uniqueReward(rewards);
    const now = new Date();
    const exp = new Date(now.getTime() + REWARD_EXPIRY_DAYS * 86400000).toISOString().slice(0, 10);
    try { await rewards.setJSON("reward:" + rewardCode, { code: rewardCode, loyaltyCode: code, childName: rec.childName,
      type: "free-visit", issuedAt: now.toISOString(), expiry: exp, used: false }); } catch {}
    rec.punches = 0;
    rec.rewardsEarned = (rec.rewardsEarned || 0) + 1;
    rec.lastRewardCode = rewardCode;
    rec.history.push({ at: now.toISOString(), action: "reward-earned", rewardCode, expiry: exp });
    rewardIssued = { rewardCode, expiry: exp };
  }

  try { await loyalty.setJSON("card:" + code, rec); } catch { return { error: true }; }
  if (visitMeta) await pushVisit(loyalty, code, visitMeta, false);
  return { code, childName: rec.childName, isNew, punches: rec.punches, needed: PUNCHES_FOR_REWARD, noPunch: !!noPunch,
    rewardIssued: !!rewardIssued, rewardCode: rewardIssued ? rewardIssued.rewardCode : null,
    rewardExpiry: rewardIssued ? rewardIssued.expiry : null,
    waiverSigned: rec.waiverSigned || null, waiverExpiry: rec.waiverExpiry || null,
    militaryVerified: !!rec.militaryVerified };
}

async function uniqueReward(store) {
  for (let i = 0; i < 8; i++) {
    let s = "FREE";
    for (let j = 0; j < 4; j++) s += REWARD_ALPHABET[Math.floor(Math.random() * REWARD_ALPHABET.length)];
    try { const e = await store.get("reward:" + s, { type: "json" }); if (!e) return s; } catch { return s; }
  }
  return "FREE" + Date.now().toString(36).toUpperCase().slice(-5);
}

function studioName() { return process.env.STUDIO_NAME || "Little Haven Play Studio"; }
function esc(s) { return String(s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// The review request now lives in lib-email.js so every thank-you email shares it.
function reviewFooter() { return reviewRequestHtml(); }

// Punch-card emails are retired (program ended). Kept as no-ops so nothing that
// still imports them can send one by accident.
export async function sendWelcome() { return; }
export async function sendReward() { return; }
export async function sendFamilyPunch() { return; }

// The legacy prepaid punch card was discontinued and can't be reloaded. When one
// runs out, this saves a profile for the child (records only, no email) and sends
// one short "your card is complete" note.
// Shared by book.js and checkin.js.
export async function graduateLegacyCard(loyalty, pass) {
  const first = (pass.childName || "").trim().split(/\s+/)[0] || "";
  const last = (pass.childName || "").trim().split(/\s+/).slice(1).join(" ") || "";
  const phone4 = last4(pass.buyerPhone || "");
  const email = (pass.buyerEmail || "").trim();
  let card = null;
  if (first && last && phone4) {
    try { const r = await issueCode(loyalty, { first, last, phone4, email, suppressEmail: true }); card = r && r.code ? r : null; } catch {}
  }
  try { await sendLegacyGraduationEmail(pass, card); } catch {}
  return card;
}

async function sendLegacyGraduationEmail(pass, card) {
  const key = process.env.RESEND_API_KEY;
  const to = pass && pass.buyerEmail;
  if (!key || !to) return false;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const studio = studioName();
  const child = pass.childName ? ` for ${esc(pass.childName)}` : "";
  const site = (process.env.SITE_URL || "https://littlehavenplay.com").replace(/\/$/, "");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:0 auto;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">Your prepaid card is complete 🎈</h2>
    <p style="margin:0 0 12px;color:#5c6470">Your prepaid card${child} is all used up — thank you for being one of our earliest families!</p>
    <p style="margin:0 0 12px;color:#5c6470">Play often? Our <a href="${site}/playclub.html" style="color:#a85f59;font-weight:bold">Play Club</a> monthly membership is the best value.</p>
    <p style="margin:14px 0 0;font-size:13px;color:#5c6470">See you soon! — ${esc(studio)}</p></div>
    ${reviewFooter()}`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromHeader(from, studio), to: [to], bcc: bcc ? [bcc] : undefined,
        subject: `Your prepaid card is complete`, html: html + SIGNATURE_HTML }),
    });
    return res.ok;
  } catch { return false; }
}

// Sends ONE military-verification email covering every card passed in — call
// this with the FULL current list of verified siblings under one family
// (gathered by the caller, e.g. via the "send-military-email" action in
// loyalty.js), not per-child automatically. That's a deliberate design choice:
// an automatic per-toggle send can't know about a sibling who gets verified a
// few minutes later, so it used to split one family across two emails. Making
// this an explicit, staff-triggered action after all of a family's kids are
// verified guarantees exactly one accurate email, every time.
export async function sendMilitaryVerifiedEmail(to, cards) {
  if (!to || !Array.isArray(cards) || !cards.length) return false;
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;

  const studio = studioName();
  const names = cards.map(c => c.childName).filter(Boolean);
  const nameList = names.length > 1
    ? names.slice(0, -1).join(", ") + " and " + names.slice(-1)
    : (names[0] || "your child");
  const site = (process.env.SITE_URL || "https://littlehavenplay.com").replace(/\/$/, "");
  const one = cards.length === 1;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:0 auto;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">Thank you for your service 🎖️</h2>
    <p><b>${esc(nameList)}</b> ${one ? "is" : "are"} now set up as a military family &mdash; <b>10% off admission</b> from now on.</p>
    <p style="margin-top:14px">We're glad to have your family with us!</p>
    <p style="font-size:14px;color:#5c6470">— ${esc(studio)}</p></div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${studio} <${process.env.EMAIL_FROM || "onboarding@resend.dev"}>`, to: [to], bcc: process.env.STUDIO_EMAIL ? [process.env.STUDIO_EMAIL] : undefined,
        subject: `Thank you for your service — your military discount is set up 🎖️`, html: html + SIGNATURE_HTML }),
    });
    return res.ok;
  } catch { return false; }
}
