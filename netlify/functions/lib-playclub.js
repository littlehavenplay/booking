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

// Which admission tier a plan actually pays for.
//
// A "Weekday Play Club - Baby/Infant" is priced against a $19 baby admission,
// not a $25 regular one, so it must not hand out $25 of cover. Before this
// existed, every plan credited the REGULAR price whatever tier it was sold at,
// and a Baby/Infant member booking a regular admission was covered in full.
//
// Resolution order: an explicit planTier saved on the membership or its plan
// wins; otherwise it is read from the plan name, which is where the tier has
// always been written ("... - Baby/Infant"). Anything unrecognised stays
// "regular", which is what every plan did before, so nothing changes for plans
// that don't name a tier.
// How many of EACH admission tier a plan covers, in the order they should be
// booked.
//
// coverAdmissionFor() below returns ONE tier for the whole membership, which is
// wrong for any plan covering a mix. "Any Day Play Club - 1 Toddler + 1 Sibling"
// matched /sibling/ and booked BOTH covered children as sibling add-ons with no
// regular admission -- a combination book.js rejects outright ("Sibling add-on
// requires at least one regular admission"), so the member simply could not
// book online. This resolves the real composition instead.
const TIER_WORD = {
  toddler: "regular", regular: "regular", child: "regular", kid: "regular",
  baby: "infant", infant: "infant",
  sibling: "sibling", sib: "sibling",
};

export function coverCompositionFor(m, plan) {
  const cap = Math.max(1, Math.min(10,
    parseInt((m && m.maxChildren) || (plan && plan.maxChildren), 10) ||
    ((m && m.children) || []).filter(c => c && c.name).length || 1));

  // An explicit tier set by staff wins outright and applies to every child.
  const explicit = String((m && m.planTier) || (plan && plan.tier) || "").toLowerCase();
  if (explicit === "infant" || explicit === "sibling" || explicit === "regular") {
    return Array(cap).fill(explicit);
  }

  const text = [m && m.planName, plan && plan.name, plan && plan.category]
    .filter(Boolean).join(" ").toLowerCase();

  const counts = { regular: 0, infant: 0, sibling: 0 };
  let found = false;
  for (const mm of text.matchAll(/(\d+)\s*([a-z/]+)/g)) {
    const n = parseInt(mm[1], 10);
    for (const part of mm[2].split("/")) {
      const tier = TIER_WORD[part.replace(/s$/, "")];
      if (tier) { counts[tier] += n; found = true; break; }
    }
  }
  if (!found) {
    // No counts in the name. Cover the family the way a walk-in family of the
    // same size is charged: one full admission, the rest as sibling add-ons.
    if (/\b(baby|infant)\b/.test(text)) { counts.infant = 1; counts.sibling = cap - 1; }
    else                                 { counts.regular = 1; counts.sibling = cap - 1; }
  }

  // Regulars and infants first: a sibling add-on is only valid alongside one.
  let out = [].concat(
    Array(Math.max(0, counts.regular)).fill("regular"),
    Array(Math.max(0, counts.infant)).fill("infant"),
    Array(Math.max(0, counts.sibling)).fill("sibling"));

  if (out.length > cap) out = out.slice(0, cap);
  while (out.length < cap) out.push(out.length ? "sibling" : "regular");

  // A sibling add-on is only valid alongside a REGULAR admission -- an infant
  // does not satisfy it (studio rule, and book.js enforces it). So a Baby/Infant
  // plan covering two children resolves to infant + regular, not infant +
  // sibling, which the server would have refused exactly like the toddler case.
  if (out.some(t => t === "sibling") && !out.some(t => t === "regular")) {
    out[out.indexOf("sibling")] = "regular";
  }
  return out;
}

export function coverAdmissionFor(m, plan) {
  const explicit = String((m && m.planTier) || (plan && plan.tier) || "").toLowerCase();
  if (explicit === "infant" || explicit === "sibling" || explicit === "regular") return explicit;
  const text = [
    m && m.planName, plan && plan.name, plan && plan.category,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(baby|infant)\b/.test(text)) return "infant";
  if (/\bsibling\b/.test(text))       return "sibling";
  return "regular";
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
