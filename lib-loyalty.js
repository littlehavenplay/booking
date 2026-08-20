// Shared loyalty punch-card logic, used by loyalty.js (staff tool), book.js
// (auto-issue codes at booking), and checkin.js (punch at check-in).
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";

export const PUNCHES_FOR_REWARD = 7;      // 7 paid visits → 8th is free
export const REWARD_EXPIRY_DAYS = 30;
const REWARD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const HERO_IMG = "https://littlehavenplay.com/assets/punch-card-hero.jpg";

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

// Auto-issue a child's loyalty code (no punch). Creates the card if new and sends
// the welcome email (with the punch card image). Returns { code, isNew }.
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
  if (fresh.buyerEmail && !suppressEmail) { try { await sendWelcome(fresh); } catch {} }
  if (visitMeta) await pushVisit(loyalty, code, visitMeta, true);
  return { code, isNew: true, childName: fresh.childName, rec: fresh };
}

// Add ONE punch to a child's card. Creates the card if new (welcome email), and
// on the 7th punch issues a free-visit reward code (reward email). Returns details.
// noPunch: record the visit and everything else, but DON'T advance the loyalty
// count. Used for a free birthday admission — the child was here, so it belongs
// in their visit history, but a free visit shouldn't earn progress toward another
// free visit.
export async function addPunch(loyalty, { first, last, phone4, email, code: directCode, suppressEmail, waiverSigned, adultNames, militaryVerified, dob, visitMeta, noPunch, birthdayYear }) {
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

  // A birthday admission still counts as a visit — it just doesn't earn a punch.
  if (!noPunch) rec.punches = (rec.punches || 0) + 1;
  rec.totalVisits = (rec.totalVisits || 0) + 1;
  rec.lastVisit = new Date().toISOString();
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  rec.history.push(noPunch
    ? { at: rec.lastVisit, action: "birthday-visit", punches: rec.punches || 0, note: "Free birthday admission — no punch" }
    : { at: rec.lastVisit, action: "punch", punches: rec.punches });

  // Stamp the birthday as used for this year so neither cron pass emails another
  // code. Mirrors what the manual issue buttons write.
  if (birthdayYear) {
    rec.lastSentYear = birthdayYear;
    rec.dayOfSentYear = birthdayYear;
    rec.birthdayUsedYear = birthdayYear;
    rec.birthdayUsedAt = rec.lastVisit;
  }

  if (isNew && rec.buyerEmail && !suppressEmail) { try { await sendWelcome(rec); } catch {} }

  let rewardIssued = null;
  if (!noPunch && rec.punches >= PUNCHES_FOR_REWARD) {
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
    if (rec.buyerEmail && !suppressEmail) { try { await sendReward(rec, rewardCode, exp); } catch {} }
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

// Bright "leave us a review" block appended to loyalty emails (no extra emails sent).
function reviewFooter() {
  const btn = (href, bg, label) =>
    `<a href="${href}" target="_blank" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;font-weight:800;font-size:13px;padding:9px 16px;border-radius:22px;margin:4px 4px">${label}</a>`;
  return `<div style="margin:20px 0 0;padding:16px;background:#fdf1ec;border:1px solid #f0d9d2;border-radius:14px;text-align:center">
    <div style="font-size:15px;font-weight:800;color:#a85f59;margin-bottom:2px">Loved your visit? 💛</div>
    <div style="font-size:13px;color:#5c6470;margin-bottom:10px">A quick review means the world to our small studio!</div>
    ${btn("https://g.page/r/CRSz8WUH8sS2EBM/review", "#4285F4", "Google")}
    ${btn("https://www.yelp.com/writeareview/biz/dmZg1HQxKJj2lcQbKFHpaQ?review_origin=writeareview-search", "#d32323", "Yelp")}
    ${btn("https://www.facebook.com/Littlehavenplay/reviews/", "#1877F2", "Facebook")}
  </div>`;
}

export async function sendWelcome(rec) {
  const key = process.env.RESEND_API_KEY; if (!key || !rec.buyerEmail) return;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const studio = studioName();
  const militaryBlock = rec.militaryVerified ? `
    <div style="background:#f3f7ee;border:1px solid #dce8cf;border-radius:12px;padding:14px 16px;margin:14px 0">
      <div style="font-weight:800;color:#4d7848;margin-bottom:4px">🎖️ Thank you for your service!</div>
      <p style="margin:0;font-size:14px;color:#4d6b3e">We've verified your military ID, and this card is marked as a military family. <b>10% off admission</b> will apply automatically every time you book Open Play online — just keep the code above handy and enter it at checkout, same as always. No separate discount code needed.</p>
    </div>` : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:0 auto;line-height:1.6">
    <img src="${HERO_IMG}" alt="Little Haven Punch Card" style="width:100%;border-radius:16px;display:block;margin:0 0 16px">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">Welcome to our Punch Card! 🌿</h2>
    <p style="margin:0 0 12px;color:#5c6470">Thanks for visiting ${esc(studio)}! Here's the punch card code for <b>${esc(rec.childName)}</b> — give it (or their name) each visit and we'll keep track for you.</p>
    <div style="background:#fcfaf6;border:1px solid #efe7da;border-radius:12px;padding:14px 16px;margin:10px 0;text-align:center">
      <div style="font-size:13px;color:#5c6470">Punch card code</div>
      <div style="font-size:26px;font-weight:900;letter-spacing:2px;color:#a85f59;margin:4px 0">${esc(rec.code)}</div>
    </div>
    ${militaryBlock}
    <p style="margin:12px 0 0;font-size:14px;color:#5c6470">After <b>7 visits</b>, your <b>8th visit is on us — free!</b> 🎈 We'll email your free-visit code the moment you earn it.</p>
    <p style="margin:14px 0 0;font-size:13px;color:#5c6470">See you soon! — ${esc(studio)}</p>
    ${reviewFooter()}</div>`;
  await fetch("https://api.resend.com/emails", { method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `${studio} <${from}>`, to: [rec.buyerEmail], bcc: bcc ? [bcc] : undefined,
      subject: rec.militaryVerified ? `Your ${studio} punch card code — and thank you for your service 🎖️` : `Your ${studio} punch card code`,
      html: html + SIGNATURE_HTML }) });
}

// The legacy prepaid punch card product was discontinued — it can no longer be
// "reloaded." When one of those cards runs out, this replaces the old (wrong)
// "reload the same code" email: it links the family into the free Loyalty Punch
// Card program (creating their loyalty card if they don't already have one from
// booking online) and tells them plainly there's nothing left to buy or reload —
// they just keep booking normally and every 8th visit is free automatically.
// Shared by book.js, checkin.js, and lib-refill.js so this logic lives in one place.
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
  const codeBlock = card && card.code
    ? `<div style="background:#fcfaf6;border:1px solid #efe7da;border-radius:12px;padding:14px 16px;margin:10px 0;text-align:center">
         <div style="font-size:13px;color:#5c6470">Your new loyalty punch card code</div>
         <div style="font-size:26px;font-weight:900;letter-spacing:2px;color:#a85f59;margin:4px 0">${esc(card.code)}</div>
       </div>`
    : `<p style="margin:10px 0;color:#5c6470">Just book your next visit online with the same name and phone number, and we'll automatically start your new free punch card — no code to remember.</p>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:0 auto;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">Your punch card is complete 🎈</h2>
    <p style="margin:0 0 12px;color:#5c6470">Your prepaid punch card${child} is all used up — thank you for being one of our earliest families! That prepaid card has been retired, so there's nothing left to buy or reload.</p>
    <p style="margin:0 0 12px;color:#5c6470">Going forward, you're on our new <b>free Loyalty Punch Card</b> program instead: pay your normal admission each visit, and once you've paid for <b>7 visits, your 8th is on us</b> — automatically, no purchase needed.</p>
    ${codeBlock}
    <p style="margin:12px 0 0;font-size:13px;color:#5f7d52">☕ Punch card holders get free coffee every visit, plus 2 adults included.</p>
    <p style="margin:14px 0 0;font-size:13px;color:#5c6470">See you soon! — ${esc(studio)}</p></div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${studio} <${from}>`, to: [to], bcc: bcc ? [bcc] : undefined,
        subject: `Your punch card is complete — you're on our free loyalty program now`, html: html + SIGNATURE_HTML }),
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
  const codeBlocks = cards.map(c => `
    <div style="text-align:center;margin:10px 0;background:#fcfaf6;border:1px solid #efe7da;border-radius:12px;padding:12px 16px">
      <div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8a8276;font-weight:bold">${esc(c.childName || "Loyalty code")}</div>
      <div style="font-size:26px;font-weight:900;letter-spacing:2px;color:#a85f59;margin-top:2px">${esc(c.code)}</div>
    </div>`).join("");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:520px;margin:0 auto;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">Thank you for your service 🎖️</h2>
    <p>Hi there,</p>
    <p>We've verified your military ID in person, and <b>${esc(nameList)}</b>'s loyalty card${cards.length > 1 ? "s are" : " is"} now marked as a military family.</p>
    <p>Going forward, <b>10% off admission</b> will apply automatically every time you book Open Play online — just enter the code below at checkout, same as always. No separate discount code needed.</p>
    ${cards.length > 1 ? `<p style="font-size:14px;color:#5c6470">Each child has their own code — screenshot this and use whichever one applies at checkout:</p>` : ""}
    ${codeBlocks}
    <p style="font-size:14px;color:#8a8276">A couple of things to know: this discount applies to the admission itself only (not the adult add-on), and it can't be combined with a discount code or the Weekday Special — whichever is bigger automatically applies.</p>
    <p style="margin-top:14px">Thank you again for your service — we're glad to have your family with us!</p>
    <p style="font-size:14px;color:#5c6470">— ${esc(studio)}</p></div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${studio} <${process.env.EMAIL_FROM || "onboarding@resend.dev"}>`, to: [to],
        subject: `Thank you for your service — your military discount is set up 🎖️`, html: html + SIGNATURE_HTML }),
    });
    return res.ok;
  } catch { return false; }
}

export async function sendReward(rec, rewardCode, expiry) {
  const key = process.env.RESEND_API_KEY; if (!key || !rec.buyerEmail) return;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const studio = studioName();
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:0 auto;line-height:1.6">
    <img src="${HERO_IMG}" alt="Little Haven Punch Card" style="width:100%;border-radius:16px;display:block;margin:0 0 16px">
    <h2 style="color:#4d6b3e;font-weight:normal;margin:0 0 4px">You've earned a FREE visit! 🎉</h2>
    <p style="margin:0 0 12px;color:#5c6470">Thanks for being part of the ${esc(studio)} family, <b>${esc(rec.childName)}</b>! You've completed 7 visits — so your next one is <b>on us</b>. 🎈</p>
    <div style="background:#eaf4e4;border:1px solid #cfe6c2;border-radius:12px;padding:14px 16px;margin:10px 0;text-align:center">
      <div style="font-size:13px;color:#4d6b3e">Your free-visit code</div>
      <div style="font-size:26px;font-weight:900;letter-spacing:2px;color:#4d6b3e;margin:4px 0">${esc(rewardCode)}</div>
      <div style="font-size:13px;color:#5c6470">Enter it at checkout on your next online booking</div>
    </div>
    <p style="margin:12px 0 0;font-size:13px;color:#5c6470"><i>Valid 30 days — through ${esc(expiry)}. One free open-play admission, any age. One-time use.</i></p>
    <p style="margin:14px 0 0;font-size:13px;color:#5c6470">Come play soon! — ${esc(studio)}</p>
    ${reviewFooter()}</div>`;
  await fetch("https://api.resend.com/emails", { method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `${studio} <${from}>`, to: [rec.buyerEmail], bcc: bcc ? [bcc] : undefined,
      subject: `🎉 You've earned a free visit at ${studio}!`, html: html + SIGNATURE_HTML }) });
}

// ONE combined email for a whole family (multiple children punched/created together).
export async function sendFamilyPunch(email, results) {
  const key = process.env.RESEND_API_KEY; if (!key || !email || !results.length) return;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const studio = studioName();
  const rewards = results.filter(r => r.rewardIssued);
  const rows = results.map(r => `<tr>
      <td style="padding:7px 9px;font-weight:bold;border-top:1px solid #efe7da">${esc(r.childName)}</td>
      <td style="padding:7px 9px;color:#a85f59;font-weight:900;letter-spacing:1px;border-top:1px solid #efe7da">${esc(r.code)}</td>
      <td style="padding:7px 9px;color:#5c6470;border-top:1px solid #efe7da">${r.rewardIssued ? "🎉 FREE visit earned!" : (r.punches + "/" + r.needed + " visits")}</td>
    </tr>`).join("");
  const rewardBlock = rewards.length ? `<div style="background:#eaf4e4;border:1px solid #cfe6c2;border-radius:12px;padding:14px 16px;margin:12px 0">
      <b style="color:#4d6b3e">🎉 Free visit${rewards.length > 1 ? "s" : ""} earned!</b>
      ${rewards.map(r => `<div style="margin-top:6px;font-size:14px;color:#3f5a34">${esc(r.childName)} — code <b>${esc(r.rewardCode)}</b> (expires ${esc(r.rewardExpiry)}). Enter it at checkout on your next booking.</div>`).join("")}
    </div>` : "";
  const militaryKids = results.filter(r => r.militaryVerified);
  const militaryBlock = militaryKids.length ? `<div style="background:#f3f7ee;border:1px solid #dce8cf;border-radius:12px;padding:14px 16px;margin:12px 0">
      <div style="font-weight:800;color:#4d7848;margin-bottom:4px">🎖️ Thank you for your service!</div>
      <p style="margin:0;font-size:14px;color:#4d6b3e">We've verified your military ID, and ${militaryKids.length > 1 ? "these cards are" : "this card is"} marked as a military family. <b>10% off admission</b> will apply automatically every time you book Open Play online — just keep ${militaryKids.length > 1 ? "the codes above" : "the code above"} handy and enter ${militaryKids.length > 1 ? "them" : "it"} at checkout, same as always. No separate discount code needed.</p>
    </div>` : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:0 auto;line-height:1.6">
    <img src="${HERO_IMG}" alt="Little Haven Punch Card" style="width:100%;border-radius:16px;display:block;margin:0 0 16px">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 4px">Your family's punch cards 🌿</h2>
    <p style="margin:0 0 12px;color:#5c6470">Thanks for visiting ${esc(studio)}! Here are the punch cards for your children — just give their names each visit and we'll keep track for you.</p>
    <table style="width:100%;border-collapse:collapse;background:#fcfaf6;border:1px solid #efe7da;border-radius:12px;overflow:hidden">
      <tr style="background:#f3ede3"><th style="padding:7px 9px;text-align:left;font-size:12px;color:#5c6470">Child</th><th style="padding:7px 9px;text-align:left;font-size:12px;color:#5c6470">Code</th><th style="padding:7px 9px;text-align:left;font-size:12px;color:#5c6470">Progress</th></tr>
      ${rows}
    </table>
    ${rewardBlock}
    ${militaryBlock}
    <p style="margin:12px 0 0;font-size:14px;color:#5c6470">After <b>7 visits</b> each, the <b>8th visit is free!</b> 🎈 We'll email you the moment anyone earns one.</p>
    <p style="margin:14px 0 0;font-size:13px;color:#5c6470">See you soon! — ${esc(studio)}</p>
    ${reviewFooter()}</div>`;
  await fetch("https://api.resend.com/emails", { method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `${studio} <${from}>`, to: [email], bcc: bcc ? [bcc] : undefined,
      subject: `Your ${studio} punch cards 🎈`, html: html + SIGNATURE_HTML }) });
}
