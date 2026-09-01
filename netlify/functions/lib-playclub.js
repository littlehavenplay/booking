// Shared Play Club membership lookup.
//
// Lives here rather than in playclub.js so book.js can use it without importing
// a whole endpoint module — and so there is exactly one definition of "is this
// family a member", which the booking page and the booking endpoint both use.
import { getStore } from "@netlify/blobs";

export function memberLast4(phone) {
  const d = (phone || "").toString().replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : "";
}

// Sunday(0) and Saturday(6), by UTC day-of-week on the naive Y-M-D string —
// matches weekdayOf() in lib-settings.js exactly, so the two never disagree
// about which day a booking falls on.
export function isWeekend(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) return false;
  const d = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return d === 0 || d === 6;
}

// Does this membership's plan actually cover the day being booked? A Weekday
// plan is deliberately cheaper than Any Day, so letting it quietly cover a
// Saturday would undercut the whole pricing tier — this is the one place that
// distinction is enforced, and both book.js (authoritative) and the booking
// page (early warning) call it so they can never disagree.
export function memberCoversDate(m, dateStr) {
  if (!m) return false;
  if (m.planKind === "weekday" && isWeekend(dateStr)) return false;
  return true;
}

// Matched on the membership code when given, otherwise on the phone they book
// with — most members won't remember a code and shouldn't have to.
export async function findMemberFor({ code, phone } = {}) {
  const c = (code || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const p4 = memberLast4(phone);
  if (!c && !p4) return null;
  let members = [];
  try { members = (await getStore("site").get("playclub:members", { type: "json" })) || []; }
  catch { return null; }
  const m = members.find(x => x && x.active !== false &&
    ((c && x.code === c) || (!c && p4 && x.phone4 === p4)));
  if (!m) return null;
  // Must agree with effectiveStatus() in playclub.js. A paused membership covers
  // nothing; a cancelled one still covers until the paid period ends.
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))
    .toISOString().slice(0, 10);
  if (m.pausedUntil && m.pausedUntil > today) return null;
  if (m.status === "paused" && !m.pausedUntil) return null;
  if (m.endsOn && m.endsOn < today) return null;
  return m;
}

// Record a visit against the membership, with enough detail to answer "who came,
// when, and how often are they using this?" — the question that decides whether
// a membership tier is priced right.
export async function recordMemberVisit(code, meta) {
  try {
    const store = getStore("site");
    const members = (await store.get("playclub:members", { type: "json" })) || [];
    const i = members.findIndex(m => m && m.code === code);
    if (i < 0) return;
    const at = new Date().toISOString();
    members[i].visits = (members[i].visits || 0) + 1;
    members[i].lastVisit = at;
    if (meta && meta.date) members[i].lastVisitDate = meta.date;
    members[i].history = Array.isArray(members[i].history) ? members[i].history : [];
    members[i].history.unshift({
      at,
      date: (meta && meta.date) || "",
      slot: (meta && meta.slotLabel) || (meta && meta.slot) || "",
      children: (meta && meta.children) || [],
      count: (meta && meta.count) || 0,
      bookedBy: (meta && meta.bookedBy) || "",
    });
    // Keep a rolling year or so; the roster is the permanent record.
    if (members[i].history.length > 200) members[i].history.length = 200;
    await store.setJSON("playclub:members", members);
  } catch {}
}
