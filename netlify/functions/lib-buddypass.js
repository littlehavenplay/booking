// Buddy passes for Play Club members.
//
// THE RULES (set by the studio, Sept 2026):
//   * One pass per covered child, per CALENDAR month. A one-child membership
//     gets 1; a membership covering two siblings gets 2, one assigned to each
//     child by name.
//   * A pass admits ONE friend, and only alongside the member: it is redeemed in
//     the member's own online booking, for the same session, by ticking it after
//     the membership is verified. There is no code to type, so there is nothing
//     to forward to someone who wants to visit alone.
//   * A pass assigned to a child is usable only when that child is on the
//     booking -- Otis's friend comes with Otis.
//   * It follows the plan's coverage exactly: a Weekday plan's pass can't be used
//     on a weekend, because the membership doesn't cover that day either.
//   * The friend's admission AND the adult who brings them are free. Grip socks
//     are still charged. A waiver is still required.
//   * Buddies count toward the session's capacity.
//   * Use it or lose it: the pass is for visits in that month only, and doesn't
//     roll over. A new set is issued every month.
//   * Cancelling the booking gives the pass back.
//
// Storage: blob store "buddypasses", key bp:<CODE>:<YYYY-MM>. Issuing is
// idempotent -- the record is created once per membership per month, so the
// monthly job, a lazy issue at booking time, or both together cannot produce a
// second set.

import { getStore } from "@netlify/blobs";

const STORE = "buddypasses";
const MAX_PASSES = 4;          // hard cap so a data error can't mint a pile of free visits

export function monthKeyOf(dateStr) {
  return String(dateStr || "").slice(0, 7);
}

export function thisMonth() {
  // Studio time, not UTC -- otherwise the month flips at 5pm on the last day.
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))
    .toISOString().slice(0, 7);
}

export function monthEnd(mk) {
  const [y, m] = mk.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function keyFor(code, mk) {
  return `bp:${String(code || "").toUpperCase()}:${mk}`;
}

// A short reference shown to the member and on the roster. It is NOT a
// redemption code -- nothing accepts it as input -- so sharing it achieves
// nothing. It just lets everyone talk about "pass BPK7Q2" unambiguously.
function refFor(code, mk, idx) {
  const s = `${code}|${mk}|${idx}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "BP";
  for (let j = 0; j < 4; j++) { out += A[h % A.length]; h = Math.floor(h / A.length); }
  return out;
}

// How many passes, and for whom. One per covered child, named where we know the
// child; any remaining slots are "Covered child 2" etc.
export function passPlanFor(member) {
  const named = ((member && member.children) || [])
    .filter(c => c && c.name && c.active !== false);
  const cap = Math.max(1, Math.min(MAX_PASSES,
    parseInt(member && member.maxChildren, 10) || named.length || 1));
  const out = [];
  for (let i = 0; i < cap; i++) {
    const c = named[i];
    out.push({ child: c ? c.name : `Covered child ${i + 1}`, childCode: c ? (c.code || "") : "" });
  }
  return out;
}

// Is this membership in good standing on the 1st of the month? Deliberately NOT
// memberCoversDate(): the 1st can fall on a weekend, and a Weekday member is
// still a member on a Saturday -- they just can't USE the pass that day.
export function activeForIssue(m, onDate) {
  if (!m || m.active === false) return false;
  if (m.status === "ended" || m.status === "cancelled-ended") return false;
  if (m.endsOn && m.endsOn < onDate) return false;
  if (m.pausedUntil && m.pausedUntil > onDate) return false;
  if (m.status === "paused" && !m.pausedUntil) return false;
  return true;
}

export async function readPasses(code, mk) {
  try { return (await getStore(STORE).get(keyFor(code, mk), { type: "json" })) || null; }
  catch { return null; }
}

// Create this month's passes if they don't exist yet. Returns the record.
export async function ensureIssued(member, mk) {
  const existing = await readPasses(member.code, mk);
  if (existing) return existing;
  const plan = passPlanFor(member);
  const rec = {
    code: String(member.code || "").toUpperCase(),
    memberName: member.name || "",
    planName: member.planName || "",
    month: mk,
    expiresOn: monthEnd(mk),
    issuedAt: new Date().toISOString(),
    passes: plan.map((p, i) => ({
      id: `${String(member.code).toUpperCase()}-${mk}-${i + 1}`,
      ref: refFor(member.code, mk, i + 1),
      child: p.child, childCode: p.childCode,
      used: null,                          // { booking, date, slot, buddy, at }
    })),
  };
  try { await getStore(STORE).setJSON(keyFor(member.code, mk), rec); } catch { return null; }
  return rec;
}

export function unusedPasses(rec) {
  return rec ? (rec.passes || []).filter(p => !p.used) : [];
}

// Which unused passes can go on THIS booking? A pass tied to a named child needs
// that child to be one of the covered children being booked.
export function eligiblePasses(rec, coveredKids) {
  const names = new Set((coveredKids || []).map(k => String(k.name || k || "").trim().toLowerCase()));
  const codes = new Set((coveredKids || []).map(k => String(k.code || "").trim().toUpperCase()).filter(Boolean));
  const unnamedRoom = Math.max(0, (coveredKids || []).length);
  let unnamedUsed = 0;
  return unusedPasses(rec).filter(p => {
    const named = !/^Covered child \d+$/.test(p.child);
    if (!named) { if (unnamedUsed < unnamedRoom) { unnamedUsed++; return true; } return false; }
    return names.has(p.child.trim().toLowerCase()) || (p.childCode && codes.has(p.childCode.toUpperCase()));
  });
}

// Mark passes used by a booking. Re-reads first and only claims passes that are
// still unused, so two bookings racing for the same pass can't both have it.
// Returns { ok, used: [...], missing: [...] }.
export async function consume(code, mk, wanted, info) {
  const store = getStore(STORE);
  const rec = await readPasses(code, mk);
  if (!rec) return { ok: false, used: [], missing: wanted.map(w => w.id) };
  const used = [], missing = [];
  for (const w of wanted) {
    const p = (rec.passes || []).find(x => x.id === w.id);
    if (!p || p.used) { missing.push(w.id); continue; }
    p.used = {
      booking: String(info.booking || ""), date: info.date || "", slot: info.slot || "",
      buddy: String(w.buddy || "").slice(0, 60), at: new Date().toISOString(),
    };
    used.push({ id: p.id, ref: p.ref, child: p.child, buddy: p.used.buddy });
  }
  if (used.length) { try { await store.setJSON(keyFor(code, mk), rec); } catch { return { ok: false, used: [], missing: wanted.map(w => w.id) }; } }
  return { ok: missing.length === 0, used, missing };
}

// Give passes back -- a cancelled booking, or staff undoing a mistake.
export async function release(code, mk, { booking, passId } = {}) {
  const store = getStore(STORE);
  const rec = await readPasses(code, mk);
  if (!rec) return { ok: false, released: 0 };
  let n = 0;
  for (const p of rec.passes || []) {
    if (!p.used) continue;
    if ((booking && p.used.booking === String(booking)) || (passId && p.id === passId)) { p.used = null; n++; }
  }
  if (n) { try { await store.setJSON(keyFor(code, mk), rec); } catch { return { ok: false, released: 0 }; } }
  return { ok: true, released: n };
}

// Monthly run: issue for every membership in good standing on the 1st.
export async function issueAll(mk = thisMonth()) {
  let members = [];
  try { members = (await getStore("site").get("playclub:members", { type: "json" })) || []; } catch {}
  const first = `${mk}-01`;
  let issued = 0, already = 0, skipped = 0, passes = 0;
  for (const m of members) {
    if (!m || !m.code || !activeForIssue(m, first)) { skipped++; continue; }
    const before = await readPasses(m.code, mk);
    if (before) { already++; continue; }
    const rec = await ensureIssued(m, mk);
    if (rec) { issued++; passes += rec.passes.length; } else skipped++;
  }
  return { month: mk, memberships: members.length, issued, already, skipped, passesIssued: passes };
}
