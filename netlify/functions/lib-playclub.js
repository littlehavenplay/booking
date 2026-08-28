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

// Matched on the membership code when given, otherwise on the phone they book
// with — most members won't remember a code and shouldn't have to.
export async function findMemberFor({ code, phone } = {}) {
  const c = (code || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const p4 = memberLast4(phone);
  if (!c && !p4) return null;
  let members = [];
  try { members = (await getStore("site").get("playclub:members", { type: "json" })) || []; }
  catch { return null; }
  return members.find(m => m && m.active !== false &&
    ((c && m.code === c) || (!c && p4 && m.phone4 === p4))) || null;
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
