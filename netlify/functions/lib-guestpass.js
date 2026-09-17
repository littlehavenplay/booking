// Guest passes for Play Club members.
//
// One pass per child the membership covers, issued on the 1st of each month.
// A one-child membership gets 1, a two-sibling membership gets 2, and so on —
// the idea being each child can bring a friend.
//
// THREE RULES, and they matter:
//
//  1. A guest pass is only valid WHEN THE MEMBER IS THERE. It admits a friend
//     visiting alongside the member's child; it is not a standalone free visit
//     that can be handed to someone to use on their own.
//  2. Passes expire at the end of the month they were issued. They don't stack —
//     a family that skips a month starts the next month with the same number,
//     not double. Otherwise a year of non-use becomes twelve free admissions.
//  3. Issuance is IDEMPOTENT per membership per month. The ledger key is
//     `gp:<code>:<YYYY-MM>`, so a cron that runs twice — or is re-run by hand —
//     cannot double-issue. This is the same lesson the birthday codes taught.

import { getStore } from "@netlify/blobs";

export const PASSES = "guestpasses";

export function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);               // YYYY-MM
}

export function monthEnd(mk) {
  const [y, m] = mk.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);   // last day of that month
}

// How many passes a membership gets: one per covered child, floor of 1, cap of 4
// so a data error can't mint a pile of free admissions.
export function passesFor(member) {
  const kids = (member && member.children || []).filter(c => c && c.name).length;
  const cap = Number(member && member.maxChildren) || kids || 1;
  return Math.max(1, Math.min(4, cap));
}

export function ledgerKey(code, mk) {
  return `gp:${String(code || "").toUpperCase()}:${mk}`;
}

// Read this membership's pass record for a month. Never creates anything.
export async function readPasses(code, mk = monthKey()) {
  try {
    const rec = await getStore(PASSES).get(ledgerKey(code, mk), { type: "json" });
    return rec || null;
  } catch { return null; }
}

// Issue this month's passes if they haven't been issued already.
// Returns { issued, total, used, remaining, alreadyExisted }.
export async function issueFor(member, mk = monthKey()) {
  const store = getStore(PASSES);
  const code = String(member.code || "").toUpperCase();
  const key = ledgerKey(code, mk);

  const existing = await readPasses(code, mk);
  if (existing) {
    return {
      issued: 0, total: existing.total, used: (existing.uses || []).length,
      remaining: Math.max(0, existing.total - (existing.uses || []).length),
      alreadyExisted: true,
    };
  }

  const total = passesFor(member);
  const rec = {
    code, month: mk, total,
    memberName: member.name || "",
    children: (member.children || []).filter(c => c && c.name).map(c => c.name),
    expiresOn: monthEnd(mk),
    issuedAt: new Date().toISOString(),
    uses: [],
  };
  try { await store.setJSON(key, rec); } catch { return { issued: 0, total: 0, used: 0, remaining: 0, error: true }; }
  return { issued: total, total, used: 0, remaining: total, alreadyExisted: false };
}

// Spend one pass. `by` is free text for the roster ("Ava's friend Noah").
// Refuses when the month has none left, and never goes negative.
export async function redeem(code, by, mk = monthKey()) {
  const store = getStore(PASSES);
  const key = ledgerKey(code, mk);
  const rec = await readPasses(code, mk);
  if (!rec) return { ok: false, error: "No guest passes issued for this membership this month." };
  const used = (rec.uses || []).length;
  if (used >= rec.total) {
    return { ok: false, error: `All ${rec.total} guest pass${rec.total === 1 ? "" : "es"} for ${mk} have been used.`,
             total: rec.total, used, remaining: 0 };
  }
  rec.uses = (rec.uses || []).concat([{ at: new Date().toISOString(), by: String(by || "").slice(0, 80) }]);
  try { await store.setJSON(key, rec); } catch { return { ok: false, error: "Couldn't record that. Try again." }; }
  const nowUsed = rec.uses.length;
  return { ok: true, total: rec.total, used: nowUsed, remaining: rec.total - nowUsed, expiresOn: rec.expiresOn };
}

// Undo the most recent use — for the inevitable mis-tap at the front desk.
export async function undo(code, mk = monthKey()) {
  const store = getStore(PASSES);
  const rec = await readPasses(code, mk);
  if (!rec || !(rec.uses || []).length) return { ok: false, error: "Nothing to undo this month." };
  rec.uses.pop();
  try { await store.setJSON(ledgerKey(code, mk), rec); } catch { return { ok: false, error: "Couldn't save." }; }
  return { ok: true, total: rec.total, used: rec.uses.length, remaining: rec.total - rec.uses.length };
}

// ---- shared by the HTTP endpoint and the scheduled issuer --------------------

// Only memberships that actually cover visits right now get passes. A paused or
// ended membership shouldn't quietly accrue them.
export function isActiveMember(m) {
  if (!m || m.active === false) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (m.status === "ended") return false;
  if (m.endsOn && m.endsOn < today) return false;
  if (m.pausedUntil && m.pausedUntil > today) return false;
  if (m.status === "paused" && !m.pausedUntil) return false;
  return true;
}

export async function allMembers() {
  try {
    const rec = await getStore("playclub").get("playclub:members", { type: "json" });
    return Array.isArray(rec) ? rec : (rec && rec.members) || [];
  } catch { return []; }
}

// Idempotent per membership per month: safe to run by schedule, by hand, or both.
export async function issueAll(mk = monthKey()) {
  const members = await allMembers();
  let issued = 0, skipped = 0, already = 0, passes = 0;
  for (const m of members) {
    if (!isActiveMember(m) || !m.code) { skipped++; continue; }
    const r = await issueFor(m, mk);
    if (r.alreadyExisted) already++;
    else if (r.issued > 0) { issued++; passes += r.issued; }
    else skipped++;
  }
  return { month: mk, memberships: members.length, issued, already, skipped, passesIssued: passes };
}
