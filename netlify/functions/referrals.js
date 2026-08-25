// POST /api/referrals
//
// Public (no key):
//   { action:"my-code", phone }        -> this family's referral code + share text + balance
//   { action:"check", code, phone }    -> is this code usable by this (new) phone?
// Staff/admin:
//   { key, action:"history", q }       -> every referral, who referred whom, paid or not
//   { key, action:"record", refCode, friendPhone, friendName }
//        -> log a walk-in referral by hand (the playdate case, no online booking)
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import {
  REFERRAL_STORE, FRIEND_DISCOUNT_CENTS, REFERRER_REWARD_CENTS,
  getOrCreateFamilyCode, findFamilyByCode, isNewFamily, familyStatus, normalizeRef,
  last4, reconcileLots, lotSummaryLines, shareMessage, pacificToday, addDays, creditReferrer,
} from "./lib-referral.js";

const SITE = process.env.SITE_URL || "https://littlehavenplay.com";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = (b.action || "").toString();
  const store = getStore(REFERRAL_STORE);

  // ---------- PUBLIC: look up my own code by phone ----------
  if (action === "my-code") {
    const p4 = last4(b.phone);
    if (!p4) return json({ error: "Enter the phone number you book with." }, 400);
    const fam = await getOrCreateFamilyCode(b.phone, { name: b.name, email: b.email });
    if (!fam) return json({ error: "Couldn't set up a code. Try again." }, 502);

    let balance = 0, lots = [], creditCode = null;
    if (fam.creditCode) {
      try {
        const rec = await getStore("credits").get("credit:" + fam.creditCode, { type: "json" });
        if (rec) { reconcileLots(rec); balance = rec.amount || 0; lots = lotSummaryLines(rec); creditCode = rec.code; }
      } catch {}
    }
    const share = shareMessage(fam.code, SITE);
    return json({ ok: true, code: fam.code, url: share.url, shareText: share.text,
      referredCount: fam.referredCount || 0, balance, lots, creditCode,
      friendDiscount: FRIEND_DISCOUNT_CENTS, reward: REFERRER_REWARD_CENTS });
  }

  // ---------- PUBLIC: validate a code at booking time ----------
  // This must apply EXACTLY the same rule the booking endpoint applies. When the
  // two disagreed, the page promised $5 off and the server correctly refused —
  // the customer saw one total and got charged another.
  if (action === "check") {
    const code = normalizeRef(b.code);
    if (!code) return json({ valid: false });
    const fam = await findFamilyByCode(code);
    if (!fam) return json({ valid: false, reason: "not_found" });

    const p4 = last4(b.phone);
    if (p4 && p4 === fam.phone4) return json({ valid: false, reason: "self" });

    const status = await familyStatus({
      phone: b.phone, email: b.email,
      childNames: b.childNames || [], childCodes: b.childCodes || [],
    });
    if (!status.isNew) {
      return json({ valid: false, reason: status.reason, match: status.match || "" });
    }
    return json({ valid: true, amount: FRIEND_DISCOUNT_CENTS,
      referrerName: (fam.name || "").split(" ")[0] || "" });
  }

  // ---------- STAFF / ADMIN ----------
  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Keys aren't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  // ---- Find a family's credit without knowing the code -------------------
  // Dad walks in saying "my wife has credit" and has no idea what the code is.
  // Search by phone, parent name or child name and hand back everything, with
  // each $5 lot and its own expiry so the oldest can be spent first.
  if (action === "lookup") {
    const q = (b.q || "").toString().trim().toLowerCase();
    if (q.length < 2) return json({ error: "Type a phone number, a parent name, or a child's name." }, 400);
    const qDigits = q.replace(/\D/g, "");
    const loyalty = getStore("loyalty");
    const credits = getStore("credits");

    // Which families match? Collect their phone4 + a friendly label.
    const fams = new Map();
    try {
      for (const k of await listAllKeys(loyalty, { prefix: "card:" })) {
        let c = null; try { c = await loyalty.get(k, { type: "json" }); } catch { continue; }
        if (!c) continue;
        const hay = [c.childName, c.parentName, c.buyerEmail, c.phone4].join(" ").toLowerCase();
        const phoneHit = qDigits.length >= 4 && (c.phone4 || "").indexOf(qDigits.slice(-4)) > -1;
        if (!phoneHit && hay.indexOf(q) === -1) continue;
        const key = c.phone4 || "?";
        const f = fams.get(key) || { phone4: key, children: [], parentName: c.parentName || "", email: c.buyerEmail || "" };
        if (c.childName && f.children.indexOf(c.childName) === -1) f.children.push(c.childName);
        if (!f.parentName && c.parentName) f.parentName = c.parentName;
        if (!f.email && c.buyerEmail) f.email = c.buyerEmail;
        fams.set(key, f);
      }
    } catch {}

    // Attach the referral code and every credit that belongs to each family.
    const today = pacificToday();
    const results = [];
    for (const f of fams.values()) {
      let fam = null;
      try { fam = await store.get("fam:" + f.phone4, { type: "json" }); } catch {}
      const list = [];
      try {
        for (const k of await listAllKeys(credits, { prefix: "credit:" })) {
          let rec = null; try { rec = await credits.get(k, { type: "json" }); } catch { continue; }
          if (!rec || rec.active === false) continue;
          const mine = (fam && rec.code === fam.creditCode)
            || (rec.referralFamily && rec.referralFamily === f.phone4)
            || (f.email && (rec.email || "").toLowerCase() === f.email.toLowerCase());
          if (!mine) continue;
          reconcileLots(rec);
          if (!(rec.amount > 0)) continue;
          list.push({
            code: rec.code, amount: rec.amount, type: rec.type || "credit",
            expiry: rec.expiry || null, nextExpiry: rec.nextExpiry || rec.expiry || null,
            lots: (rec.lots || []).filter(l => l.remaining > 0)
              .sort((a, c2) => (a.expiry || "").localeCompare(c2.expiry || ""))
              .map(l => ({ remaining: l.remaining, expiry: l.expiry, earned: l.earned,
                           expiringSoon: !!(l.expiry && l.expiry <= addDays(today, 7)) })),
          });
        }
      } catch {}
      results.push({ ...f, referralCode: fam ? fam.code : null,
        referredCount: fam ? (fam.referredCount || 0) : 0, credits: list,
        total: list.reduce((s, c2) => s + c2.amount, 0) });
    }
    results.sort((a, c2) => c2.total - a.total);
    return json({ ok: true, families: results.slice(0, 25), count: results.length });
  }

  // ---- Deduct in store, oldest money first --------------------------------
  if (action === "redeem") {
    const code = (b.code || "").toString().trim().toUpperCase();
    const dollars = parseFloat(b.amount);
    if (!code) return json({ error: "Missing credit code." }, 400);
    if (!(dollars > 0)) return json({ error: "Enter an amount greater than 0." }, 400);
    const cents = Math.round(dollars * 100);
    const credits = getStore("credits");
    let rec = null;
    try { rec = await credits.get("credit:" + code, { type: "json" }); } catch {}
    if (!rec) return json({ error: "That credit code wasn't found." }, 404);

    reconcileLots(rec);
    if (rec.amount < cents) {
      return json({ error: `Only $${(rec.amount / 100).toFixed(2)} left on that code.` }, 409);
    }

    // Burn the soonest-to-expire lots first so nothing is wasted.
    let left = cents;
    const used = [];
    for (const l of (rec.lots || []).sort((a, c2) => (a.expiry || "").localeCompare(c2.expiry || ""))) {
      if (left <= 0) break;
      const take = Math.min(l.remaining, left);
      if (take > 0) { l.remaining -= take; left -= take; used.push({ amount: take, expiry: l.expiry }); }
    }
    rec.amount = Math.max(0, rec.amount - cents);
    reconcileLots(rec);
    rec.history = Array.isArray(rec.history) ? rec.history : [];
    rec.history.push({ at: new Date().toISOString(), action: "redeemed-instore", amount: cents,
      where: "in store", note: (b.note || "").toString().slice(0, 160),
      by: (b.by || "").toString().slice(0, 60) });
    try { await credits.setJSON("credit:" + code, rec); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }

    return json({ ok: true, code, deducted: cents, balance: rec.amount,
      usedLots: used, nextExpiry: rec.nextExpiry,
      message: `Deducted $${(cents / 100).toFixed(2)} — oldest credit used first. $${(rec.amount / 100).toFixed(2)} left`
        + (rec.nextExpiry ? `, next expires ${rec.nextExpiry}.` : ".") });
  }

  if (action === "history") {
    const q = (b.q || "").toString().trim().toLowerCase();
    const out = [];
    try {
      const keys = await listAllKeys(store, { prefix: "ref:" });
      for (const k of keys) {
        let r = null; try { r = await store.get(k, { type: "json" }); } catch { continue; }
        if (!r) continue;
        if (q) {
          const hay = [r.refCode, r.referrerName, r.friendName, r.friendEmail, r.referrerPhone4, r.friendPhone4]
            .join(" ").toLowerCase();
          if (hay.indexOf(q) === -1) continue;
        }
        out.push(r);
      }
    } catch {}
    out.sort((a, c) => String(c.at || "").localeCompare(String(a.at || "")));

    // Balances are read live so the list can't drift from the credit records.
    const balances = {};
    for (const r of out) {
      if (!r.creditCode || balances[r.creditCode] !== undefined) continue;
      try {
        const rec = await getStore("credits").get("credit:" + r.creditCode, { type: "json" });
        if (rec) { reconcileLots(rec); balances[r.creditCode] = { balance: rec.amount || 0, lots: lotSummaryLines(rec) }; }
      } catch {}
    }
    const pending = out.filter(r => !r.paidAt).length;
    const flagged = out.filter(r => r.needsReview && !r.paidAt && !r.reviewDismissed).length;
    return json({ ok: true, referrals: out.slice(0, 300), count: out.length, pending, flagged, balances });
  }

  // Playdate case: an existing family walks in with a brand-new friend and no
  // online booking ever happens, so nothing on the site would catch it.
  // Approve or reject a flagged referral. Approving pays the referrer their $5
  // right away; rejecting leaves the friend's discount alone (they already had
  // their visit) and simply doesn't reward the referrer.
  if (action === "review") {
    const id = (b.id || "").toString();
    const approve = b.approve === true || b.approve === "1";
    if (!id) return json({ error: "Missing referral id." }, 400);
    const key = "ref:" + id;
    let rec = null; try { rec = await store.get(key, { type: "json" }); } catch {}
    if (!rec) return json({ error: "That referral wasn't found." }, 404);
    if (rec.paidAt) return json({ error: "That referral has already been rewarded." }, 409);

    rec.reviewedAt = new Date().toISOString();
    rec.reviewedBy = (b.by || "").toString().slice(0, 60);
    rec.reviewNote = (b.note || "").toString().slice(0, 160);

    if (!approve) {
      rec.reviewDismissed = true;
      rec.needsReview = false;
      try { await store.setJSON(key, rec); } catch { return json({ error: "Couldn't save." }, 502); }
      return json({ ok: true, message: "Marked as not a valid referral. No credit was issued." });
    }

    const fam = await findFamilyByCode(rec.refCode);
    if (!fam) return json({ error: "Couldn't find the referrer's family." }, 404);
    const credit = await creditReferrer(fam, { friendName: rec.friendName || "" });
    if (!credit) return json({ error: "Couldn't issue the credit. Try again." }, 502);
    rec.paidAt = new Date().toISOString();
    rec.creditCode = credit.code;
    rec.needsReview = false;
    try { await store.setJSON(key, rec); } catch {}
    return json({ ok: true, creditCode: credit.code, balance: credit.amount,
      message: `Approved. $5 added to ${rec.referrerName || "the referrer"} — code ${credit.code}, balance $${((credit.amount || 0) / 100).toFixed(2)}.` });
  }

  if (action === "record") {
    const fam = await findFamilyByCode(b.refCode);
    if (!fam) return json({ error: "That referral code doesn't match anyone." }, 404);
    const fp4 = last4(b.friendPhone);
    if (!fp4) return json({ error: "Enter the friend's phone number." }, 400);
    if (fp4 === fam.phone4) return json({ error: "That's the same phone number as the referrer." }, 400);
    if (!(await isNewFamily(b.friendPhone))) {
      return json({ error: "That phone already has a loyalty card, so they're not a new family." }, 409);
    }
    const existing = await findReferralForFriend(store, fp4);
    if (existing) return json({ error: "That family has already been referred once." }, 409);

    const rec = {
      id: "manual-" + Date.now().toString(36),
      refCode: fam.code, referrerPhone4: fam.phone4, referrerName: fam.name || "",
      friendPhone4: fp4, friendName: (b.friendName || "").toString().slice(0, 80),
      friendEmail: "", source: "in-store", at: new Date().toISOString(),
      bookingDate: pacificToday(), discountGiven: 0, paidAt: null, creditCode: null,
    };
    try { await store.setJSON("ref:" + rec.id, rec); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, referral: rec,
      message: `Logged. ${fam.name || "The referrer"} gets their $5 once ${rec.friendName || "the friend"} is checked in.` });
  }

  return json({ error: "Unknown action." }, 400);
};

export async function findReferralForFriend(store, friendPhone4) {
  try {
    const keys = await listAllKeys(store, { prefix: "ref:" });
    for (const k of keys) {
      let r = null; try { r = await store.get(k, { type: "json" }); } catch { continue; }
      if (r && r.friendPhone4 === friendPhone4) return r;
    }
  } catch {}
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/referrals" };
