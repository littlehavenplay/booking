// Shared referral logic. Kept in one place so the booking page, the check-in
// payout, the customer /refer page and the staff history all agree.
//
// KEY DESIGN DECISIONS
//
// 1. The referral code belongs to a PHONE NUMBER, not a child and not a name.
//    Loyalty codes are per child, so a family with three kids would otherwise
//    have three referral codes — and the credit belongs to the parent anyway.
//    Phone-keyed also survives the common mistake of a parent typing their own
//    name into the child's name field at booking.
//
// 2. One credit code per family that TOPS UP, but with per-$5 expiry. A single
//    balance with a single expiry can't answer "which $5 expires first", and a
//    pile of separate codes can't be spent together. So one code holds dated
//    "lots"; spending consumes the oldest first, and each lot expires 60 days
//    from the day it was earned.
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { makeCredit } from "./lib-credit.js";

export const REFERRAL_STORE = "referrals";
export const FRIEND_DISCOUNT_CENTS = 500;   // $5 off the new family's first booking
export const REFERRER_REWARD_CENTS = 500;   // $5 credit to the referrer
export const LOT_EXPIRY_DAYS = 60;

// No 0/O or 1/I/L — these get read aloud and typed from screenshots.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function pacificToday() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))
    .toISOString().slice(0, 10);
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function last4(phone) {
  const d = (phone || "").toString().replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : "";
}

export function normalizeRef(code) {
  return (code || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function randomCode(n = 5) {
  let s = "";
  const bytes = new Uint8Array(n);
  (globalThis.crypto || require("node:crypto").webcrypto).getRandomValues(bytes);
  for (let i = 0; i < n; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return "REF" + s;
}

// ---------------------------------------------------------------------------
// Family referral code, keyed on the last 4 of the phone (same grouping the
// loyalty cards already use for siblings).
// ---------------------------------------------------------------------------
export async function getOrCreateFamilyCode(phone, opts = {}) {
  const p4 = last4(phone);
  if (!p4) return null;
  const store = getStore(REFERRAL_STORE);
  const key = "fam:" + p4;
  let rec = null;
  try { rec = await store.get(key, { type: "json" }); } catch {}
  if (rec && rec.code) {
    // Keep the friendliest name we've seen, without ever blanking one we have.
    if (opts.name && !rec.name) { rec.name = opts.name; try { await store.setJSON(key, rec); } catch {} }
    if (opts.email && !rec.email) { rec.email = opts.email; try { await store.setJSON(key, rec); } catch {} }
    return rec;
  }
  // Collision is vanishingly unlikely at this scale, but check anyway.
  let code = randomCode();
  for (let i = 0; i < 5; i++) {
    let clash = null;
    try { clash = await store.get("code:" + code, { type: "json" }); } catch {}
    if (!clash) break;
    code = randomCode();
  }
  rec = {
    code, phone4: p4,
    name: (opts.name || "").toString().slice(0, 80),
    email: (opts.email || "").toString().slice(0, 160),
    createdAt: new Date().toISOString(),
    creditCode: null,          // filled in on the first successful referral
    referredCount: 0,
  };
  try {
    await store.setJSON(key, rec);
    await store.setJSON("code:" + code, { phone4: p4 });   // reverse lookup
  } catch { return null; }
  return rec;
}

export async function findFamilyByCode(code) {
  const c = normalizeRef(code);
  if (!c) return null;
  const store = getStore(REFERRAL_STORE);
  let ptr = null;
  try { ptr = await store.get("code:" + c, { type: "json" }); } catch {}
  if (!ptr || !ptr.phone4) return null;
  try { return await store.get("fam:" + ptr.phone4, { type: "json" }); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Is this phone genuinely a new family? A loyalty card is created on the first
// booking, so having one is a reliable "they've been here before".
// ---------------------------------------------------------------------------
// Why a family is or isn't new. Returns a REASON so the booking page can say
// something specific instead of a vague rejection.
//
// Phone alone is not enough: mum and dad have different numbers, so a second
// phone looks brand new. Match on email and on the children's names too — if a
// child already has a loyalty card, that household has been here.
// Edit distance, capped — we only care about "close", not how far apart.
function editDistance(a, b) {
  a = a || ""; b = b || "";
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// A "soft" match: close enough to be worth a human glance, not close enough to
// refuse automatically. Refusing on a fuzzy match would block genuinely new
// families who happen to share a surname — a worse mistake than missing a fake.
function looksRelated(aFirst, aLast, bFirst, bLast) {
  const nf = s => (s || "").toLowerCase().replace(/[^a-z]/g, "");
  const [af, al, bf, bl] = [nf(aFirst), nf(aLast), nf(bFirst), nf(bLast)];
  if (!al || !bl) return false;
  const lastClose = al === bl || editDistance(al, bl) <= 2 || al.startsWith(bl) || bl.startsWith(al);
  if (!lastClose) return false;
  if (!af || !bf) return true;                       // same surname, no first name to compare
  const firstClose = af === bf || editDistance(af, bf) <= 3 || af[0] === bf[0];
  return firstClose;
}

export async function familyStatus({ phone, email, childNames, childCodes } = {}) {
  const p4 = last4(phone);
  // Fail CLOSED. If we can't identify who is booking, we do not hand out money.
  if (!p4) return { isNew: false, reason: "no_phone" };

  const mail = (email || "").toString().trim().toLowerCase();
  const kidNames = (childNames || [])
    .map(c => (typeof c === "string" ? c : ((c && ((c.first || "") + " " + (c.last || ""))) || "")))
    .map(s => s.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // An entered loyalty code is the strongest signal of all — it IS an existing child.
  const codes = (childCodes || []).map(c => (c || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean);

  const kidParts = (childNames || [])
    .map(c => (typeof c === "string" ? { first: c.split(" ")[0], last: c.split(" ").slice(1).join(" ") } : (c || {})))
    .filter(c => c && (c.first || c.last));
  let soft = null;

  try {
    const loyalty = getStore("loyalty");
    for (const k of await listAllKeys(loyalty, { prefix: "card:" })) {
      let c = null; try { c = await loyalty.get(k, { type: "json" }); } catch { continue; }
      if (!c) continue;
      if (codes.length && codes.indexOf((c.code || "").toUpperCase()) > -1)
        return { isNew: false, reason: "existing_child", match: c.childName || "" };
      if (c.phone4 === p4) return { isNew: false, reason: "existing_phone", match: c.childName || "" };
      if (mail && (c.buyerEmail || "").toLowerCase().trim() === mail)
        return { isNew: false, reason: "existing_email", match: c.childName || "" };
      if (kidNames.length) {
        const known = (c.childName || "").toLowerCase().replace(/\s+/g, " ").trim();
        if (known && kidNames.indexOf(known) > -1)
          return { isNew: false, reason: "existing_child", match: c.childName || "" };
      }
      // Not an exact match, but close enough that a person should look at it.
      // Remembered, not acted on.
      if (!soft) {
        const kf = (c.childName || "").trim().split(/\s+/);
        for (const kid of kidParts) {
          if (looksRelated(kid.first, kid.last, kf[0], kf.slice(1).join(" "))) {
            soft = { match: c.childName || "", phone4: c.phone4 || "" };
            break;
          }
        }
      }
    }
  } catch { return { isNew: false, reason: "lookup_failed" }; }
  if (soft) return { isNew: true, reason: "new", suspect: true, suspectMatch: soft.match };
  return { isNew: true, reason: "new" };
}

// Kept for callers that only need the boolean.
export async function isNewFamily(phone, opts = {}) {
  const r = await familyStatus({ phone, ...opts });
  return r.isNew;
}

// ---------------------------------------------------------------------------
// Lot bookkeeping. `lots` is the truth for expiry; `amount` is what the existing
// redemption code decrements. Reconcile brings the two back into agreement:
// drop expired lots, then consume oldest-first to match whatever was spent.
// ---------------------------------------------------------------------------
export function reconcileLots(rec, today) {
  const day = today || pacificToday();
  const lots = Array.isArray(rec.lots) ? rec.lots : [];
  const live = [], expired = [];
  for (const l of lots) {
    if (!l || !(l.remaining > 0)) continue;
    (l.expiry && l.expiry < day ? expired : live).push(l);
  }
  live.sort((a, b) => (a.expiry || "").localeCompare(b.expiry || ""));

  let liveTotal = live.reduce((s, l) => s + (l.remaining || 0), 0);
  const amount = Math.max(0, Number(rec.amount) || 0);

  // Spent since we last looked -> burn the oldest lots first.
  if (amount < liveTotal) {
    let toBurn = liveTotal - amount;
    for (const l of live) {
      if (toBurn <= 0) break;
      const take = Math.min(l.remaining, toBurn);
      l.remaining -= take; toBurn -= take;
    }
  }
  const remaining = live.filter(l => l.remaining > 0);
  liveTotal = remaining.reduce((s, l) => s + l.remaining, 0);

  rec.lots = remaining;
  rec.amount = liveTotal;            // expired money disappears from the balance
  rec.expiredTotal = (rec.expiredTotal || 0) + expired.reduce((s, l) => s + (l.remaining || 0), 0);
  // The soonest expiry is what creates urgency in the emails.
  rec.nextExpiry = remaining.length ? remaining[0].expiry : null;
  return rec;
}

export function lotSummaryLines(rec) {
  const lots = Array.isArray(rec.lots) ? rec.lots : [];
  return lots.filter(l => l.remaining > 0)
    .sort((a, b) => (a.expiry || "").localeCompare(b.expiry || ""))
    .map(l => `$${(l.remaining / 100).toFixed(2)} expires ${l.expiry}`);
}

// ---------------------------------------------------------------------------
// Pay the referrer. Creates their credit on the first referral, tops it up after
// that. Always adds a fresh dated lot.
// ---------------------------------------------------------------------------
export async function creditReferrer(fam, { friendName } = {}) {
  const credits = getStore("credits");
  const store = getStore(REFERRAL_STORE);
  const today = pacificToday();
  const lot = { amount: REFERRER_REWARD_CENTS, remaining: REFERRER_REWARD_CENTS,
                earned: today, expiry: addDays(today, LOT_EXPIRY_DAYS),
                friend: (friendName || "").toString().slice(0, 60) };

  let rec = null;
  // makeCredit stores under a "credit:" prefix — read with it or we always miss.
  if (fam.creditCode) { try { rec = await credits.get("credit:" + fam.creditCode, { type: "json" }); } catch {} }

  if (!rec) {
    rec = await makeCredit("referral", REFERRER_REWARD_CENTS,
      "Referral reward — thank you for sending a friend our way!",
      { custName: fam.name, email: fam.email, expiryDays: LOT_EXPIRY_DAYS, scope: "any", singleUse: false });
    if (!rec || !rec.code) return null;
    rec.lots = [lot];
    rec.referralFamily = fam.phone4;
  } else {
    reconcileLots(rec, today);
    rec.lots = (rec.lots || []).concat([lot]);
    rec.amount = (rec.amount || 0) + REFERRER_REWARD_CENTS;
    rec.original = (rec.original || 0) + REFERRER_REWARD_CENTS;
    rec.active = true;
    // The record-level expiry follows the LAST lot to die, so the code itself
    // never expires while any money on it is still good.
    const latest = rec.lots.map(l => l.expiry).sort().pop();
    if (latest) rec.expiry = latest;
  }
  reconcileLots(rec, today);
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  rec.history.push({ at: new Date().toISOString(), action: "referral-earned",
    amount: REFERRER_REWARD_CENTS, friend: lot.friend });

  try { await credits.setJSON("credit:" + rec.code, rec); } catch { return null; }

  if (fam.creditCode !== rec.code || true) {
    fam.creditCode = rec.code;
    fam.referredCount = (fam.referredCount || 0) + 1;
    try { await store.setJSON("fam:" + fam.phone4, fam); } catch {}
  }
  return rec;
}

export function shareMessage(code, siteUrl) {
  const url = `${siteUrl.replace(/\/$/, "")}/book?ref=${code}`;
  return {
    url,
    text: `We love Little Haven Play Studio! 🎈 Here's $5 off your first visit — use my code ${code} when you book: ${url}`,
  };
}
