// POST /api/checkin  (admin key or staff PIN)
// In-store check-ins that count toward the SAME per-session 15 capacity as
// online bookings, and update the website's "X left" automatically.
//
// Body:
//   { key, action:"walkin", count }                  -> log N walk-in children
//   { key, action:"pass", code, count }              -> use N visits on a pass + count them
//   { key, action:"profile", codes:[...], adults, birthdayCodes:[...] }
//                                                    -> check in children from their profiles:
//                                                       roster row with names + adults, a visit on
//                                                       each profile, and (birthdayCodes) the free
//                                                       birthday visit used up for the year
//   { key, action:"remove", date, slot, entryId }    -> undo a walk-in / pass check-in
//
// Walk-ins & pass check-ins are auto-assigned to the session whose START time is
// nearest the current Pacific time (e.g. 10:50 AM -> 11:00-1:00). Each is tagged
// with a timestamp so you can see exactly when each group arrived.
import { getStore } from "@netlify/blobs";
import { ARRIVAL, openPlayForDate, slotCap, slotKey, PARTY_SLOT_IDS, hoursFor, countHourChildren } from "./lib-settings.js";
import { loadSeasonal, loadWeekly } from "./lib-hours.js";
import { graduateLegacyCard, addPunch, normalizeCode } from "./lib-loyalty.js";
import { birthdayUsedThisYear, markBirthdayUsed, findChildCards, childNameKey } from "./lib-birthday.js";
import { listAllKeys } from "./lib-blobs.js";
import { findMemberFor, memberCoversDate } from "./lib-playclub.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const action = (b.action || "").toString();
  const waiverConfirmed = b.waiverConfirmed === true;   // staff confirmed all adults+children on WaiverMaster
  const bookings = getStore("bookings");

  // ---- REMOVE (undo a walk-in or pass check-in) ----
  if (action === "remove") {
    const date = (b.date || "").toString();
    const slot = (b.slot || "").toString();
    const entryId = (b.entryId || "").toString();
    const key = slotKey(date, slot);
    let rec = null; try { rec = await bookings.get(key, { type: "json", consistency: "strong" }); } catch {}
    if (!rec || !Array.isArray(rec.bookings)) return json({ error: "Nothing to remove." }, 404);
    const idx = rec.bookings.findIndex(x => x.id === entryId && (x.type === "walkin" || x.type === "pass"));
    if (idx < 0) return json({ error: "That entry can't be removed here." }, 400);
    const entry = rec.bookings[idx];
    const n = entry.children || 0;
    rec.bookings.splice(idx, 1);
    rec.children = Math.max(0, (rec.children || 0) - n);
    try { await bookings.setJSON(key, rec); } catch { return json({ error: "Couldn't update. Try again." }, 502); }
    // Desk check-in from a profile: take the visit back off each child's history,
    // and give back a birthday visit that was marked used by this check-in.
    if (entry.source === "profile" && Array.isArray(entry.profileCodes) && entry.profileCodes.length) {
      try { await undoProfileVisits(entry, date); } catch {}
    }
    // If it was a pass check-in, give the visits back to the pass
    if (entry.type === "pass" && entry.code) {
      const passes = getStore("passes");
      let p = null; try { p = await passes.get("pass:" + entry.code, { type: "json" }); } catch {}
      if (p) { p.visitsRemaining = (p.visitsRemaining || 0) + n; try { await passes.setJSON("pass:" + entry.code, p); } catch {} }
    }
    return json({ ok: true, message: `Removed ${n} ${entry.type === "pass" ? "pass check-in" : "walk-in"} child${n === 1 ? "" : "ren"}.` });
  }

  // ---- Figure out the current session from Pacific time ----
  const date = pacificDate();
  const nowMin = pacificMinutes();
  const bookedPartyIds = await bookedParties(date);
  const seasonal = await loadSeasonal();
  const weekly = await loadWeekly();
  const daySlots = openPlayForDate(date, bookedPartyIds, hoursFor(date, seasonal, weekly));
  if (!daySlots.length) return json({ error: "There are no open-play sessions today." }, 400);
  // nearest arrival start; ties go to the earlier one
  let chosen = daySlots[0];
  let bestDiff = Infinity;
  for (const s of daySlots) {
    const start = ARRIVAL[s.id]?.start ?? 0;
    const diff = Math.abs(start - nowMin);
    if (diff < bestDiff) { bestDiff = diff; chosen = s; }
  }
  // Staff can override the auto-pick by passing an explicit arrival time block.
  const reqSlot = (b.slot || "").toString();
  if (reqSlot && daySlots.some(s => s.id === reqSlot)) chosen = daySlots.find(s => s.id === reqSlot);
  const slot = chosen.id;
  const key = slotKey(date, slot);
  const cap = slotCap(slot);
  const atISO = new Date().toISOString();
  const atLabel = pacificClock();

  // ---- PASS CHECK-IN ----
  if (action === "pass") {
    const code = (b.code || "").toString().trim().toUpperCase();
    const count = Math.max(1, parseInt(b.count, 10) || 1);
    const passes = getStore("passes");
    let p = null; try { p = await passes.get("pass:" + code, { type: "json" }); } catch {}
    if (!p)               return json({ error: "That pass code wasn't found." }, 404);
    // Same contract as book.js / pass-balance.js: legacy cards carry no `active`
    // field and must still punch at the desk.
    if (p.active === false) return json({ error: "That pass is no longer active." }, 400);
    if ((p.visitsRemaining || 0) < count) return json({ error: `That pass only has ${p.visitsRemaining || 0} visit(s) left.` }, 400);
    if (p.expiry && p.expiry < date)      return json({ error: `That pass expired on ${p.expiry}.` }, 400);

    const wasRemaining = (p.visitsRemaining || 0);
    p.visitsRemaining = wasRemaining - count;
    p.usage = Array.isArray(p.usage) ? p.usage : [];
    p.usage.push({ at: atISO, count, where: "in-store", slot });

    // "Buy 7, 8th free": the visit that empties the card is the FREE one. When this
    // check-in brings the card to 0, that prepaid product is discontinued — instead
    // of prompting a reload, graduate the family into the free loyalty program.
    const freeVisit = p.visitsRemaining === 0;
    let reminderEmailed = false;
    if (freeVisit && !p.reminderSentAt) {
      try { const loyalty = getStore("loyalty"); await graduateLegacyCard(loyalty, p); p.reminderSentAt = atISO; reminderEmailed = true; } catch {}
    }
    try { await passes.setJSON("pass:" + code, p); } catch { return json({ error: "Couldn't update the pass. Try again." }, 502); }

    const rec = await addToSession(bookings, key, {
      id: crypto.randomUUID(), type: "pass", code, childName: p.childName || "", children: count,
      label: p.label || "", at: atISO, atLabel, waiverConfirmed, waiverConfirmedAt: waiverConfirmed ? atISO : null,
    });
    const hourKids = await countHourChildren(bookings, date, slot);   // whole hour (:00 + :30), not just this slot
    return json({
      ok: true, slot, slotLabel: chosen.label, atLabel,
      visitsRemaining: p.visitsRemaining, code, label: p.label || "",
      freeVisit, graduated: freeVisit, reminderEmailed,
      celebration: freeVisit ? "📋 That was their last prepaid visit. This card is now complete." : "",
      children: hourKids, cap, remaining: Math.max(0, cap - hourKids), over: hourKids > cap,
      message: freeVisit
        ? `Pass ${code} is now used up — that was their last prepaid visit (already paid for, not free). This card is now complete.`
        : `Checked in ${count} on pass ${code} to ${chosen.label}. ${p.visitsRemaining} visit(s) left.`,
    });
  }

  // ---- CHECK IN FROM A CHILD PROFILE ----
  // Siblings checked in one after another land on ONE roster row for the family
  // (same phone), like an online booking: parent name, children's names, adults.
  if (action === "profile") {
    const codes = [...new Set((Array.isArray(b.codes) ? b.codes : [b.code]).map(normalizeCode).filter(Boolean))].slice(0, 8);
    if (!codes.length) return json({ error: "Pick a child profile to check in." }, 400);
    const bdaySet = new Set((Array.isArray(b.birthdayCodes) ? b.birthdayCodes : []).map(normalizeCode).filter(Boolean));
    const adultsRaw = b.adults;
    const adultCount = (adultsRaw === undefined || adultsRaw === null || adultsRaw === "")
      ? 1 : Math.max(0, Math.min(20, parseInt(adultsRaw, 10) || 0));
    const loyalty = getStore("loyalty");
    let cards = [];
    for (const c of codes) {
      let card = null; try { card = await loyalty.get("card:" + c, { type: "json", consistency: "strong" }); } catch {}
      if (!card) return json({ error: `No profile found for ${c}.` }, 404);
      card.code = card.code || c;
      cards.push(card);
    }
    const year = date.slice(0, 4);
    const first = (n) => String(n || "").trim().split(/\s+/)[0] || "This child";

    // One free birthday visit per child per year -- checked BEFORE anything is saved.
    for (const card of cards) {
      if (!bdaySet.has(card.code)) continue;
      const chk = await birthdayUsedThisYear(loyalty, { code: card.code, childName: card.childName, dob: card.dob || "", year });
      if (chk.used) {
        return json({ error: `${first(card.childName)} already had their free birthday visit this year (${chk.how}${chk.at ? ", " + String(chk.at).slice(0, 10) : ""}). Check them in as a regular visit instead.`, birthdayUsed: true }, 409);
      }
    }

    // Already on today's roster from an ONLINE booking? Don't add a second row.
    // A birthday visit is marked on that booking instead; a regular check-in is
    // done by ticking them as arrived on the booking.
    const online = await onlineBookingsFor(bookings, date, cards);
    if (online.size) {
      const plain = cards.filter(c => online.has(c.code) && !bdaySet.has(c.code));
      if (plain.length) {
        const o = online.get(plain[0].code);
        return json({ error: `${plain.map(c => first(c.childName)).join(" & ")} booked online today (${o.entry.name || "online booking"}${o.arrivalLabel ? ", " + o.arrivalLabel : ""}) and ${plain.length === 1 ? "is" : "are"} already on the roster. Tick them as arrived there.`, onlineBooking: true }, 409);
      }
      const marked = [];
      for (const card of cards.filter(c => online.has(c.code))) {
        const o = online.get(card.code);
        await markBirthdayUsed({ loyaltyCodes: [card.code], childName: card.childName, dob: card.dob || "", year,
          usedBy: "desk", reason: "Free birthday visit at the desk" });
        // If they were already ticked as arrived, that visit becomes the birthday visit.
        try {
          for (const c2 of await findChildCards(loyalty, { code: card.code, childName: card.childName, dob: card.dob || "" })) {
            let hit = false;
            (c2.visits || []).forEach(v => { if (v.bookingId === o.entry.id) { v.source = "birthday"; v.admission = "birthday"; v.freeAdmission = true; hit = true; } });
            c2.history = Array.isArray(c2.history) ? c2.history : [];
            if (c2.code === card.code || hit) {
              c2.history.push({ at: new Date().toISOString(), action: "birthday-visit", source: "online-booking", note: "Free birthday admission (online booking)" });
              await loyalty.setJSON("card:" + c2.code, c2);
            }
          }
        } catch {}
        o.entry.birthdayNames = Array.isArray(o.entry.birthdayNames) ? o.entry.birthdayNames : [];
        if (!o.entry.birthdayNames.includes(card.childName)) o.entry.birthdayNames.push(card.childName || card.code);
        try { await bookings.setJSON(o.key, o.rec); } catch {}
        marked.push(first(card.childName));
      }
      cards = cards.filter(c => !online.has(c.code));
      if (!cards.length) {
        return json({ ok: true, onlineBooking: true, slot, slotLabel: chosen.label,
          message: `${marked.join(" & ")} \u{1F382} already on today's roster from an online booking. Marked as the free birthday visit for ${year}.` });
      }
    }

    // Find this family's row in this arrival time, if one of them is already checked in.
    const famKey = (cards[0].phone4 || "").toString();
    let rec = null; try { rec = await bookings.get(key, { type: "json", consistency: "strong" }); } catch {}
    if (!rec || typeof rec.children !== "number") rec = { children: 0, bookings: [] };
    rec.bookings = Array.isArray(rec.bookings) ? rec.bookings : [];
    let entry = rec.bookings.find(e => e && e.type === "walkin" && e.source === "profile" &&
      ((famKey && e.familyKey === famKey) || (e.profileCodes || []).some(pc => codes.includes(pc))));
    const already = entry ? cards.filter(c => (entry.profileCodes || []).includes(c.code)) : [];
    const fresh = cards.filter(c => !already.includes(c));
    if (!fresh.length) {
      // Already on the roster, and now staff tapped Birthday visit: turn that
      // check-in into the free birthday visit instead of adding them twice.
      const upgrades = already.filter(c => bdaySet.has(c.code) && !(entry.birthdayCodes || []).includes(c.code));
      if (upgrades.length) {
        for (const card of upgrades) {
          await markBirthdayUsed({ loyaltyCodes: [card.code], childName: card.childName, dob: card.dob || "", year,
            usedBy: "desk", reason: "Free birthday visit at the desk" });
          try {
            const c2 = await loyalty.get("card:" + card.code, { type: "json", consistency: "strong" });
            if (c2) {
              (c2.visits || []).forEach(v => { if (v.bookingId === entry.id) { v.source = "birthday"; v.admission = "birthday"; v.freeAdmission = true; } });
              c2.history = Array.isArray(c2.history) ? c2.history : [];
              c2.history.push({ at: new Date().toISOString(), action: "birthday-visit", source: "walkin", note: "Free birthday admission" });
              await loyalty.setJSON("card:" + card.code, c2);
            }
          } catch {}
          entry.birthdayNames = (entry.birthdayNames || []).concat([card.childName || card.code]);
          entry.birthdayCodes = (entry.birthdayCodes || []).concat([card.code]);
        }
        try { await bookings.setJSON(key, rec); } catch { return json({ error: "Couldn't update the roster. Try again." }, 502); }
        return json({ ok: true, slot, slotLabel: chosen.label, atLabel: entry.atLabel, entryId: entry.id, upgraded: true,
          checkedIn: upgrades.map(c => ({ code: c.code, childName: c.childName || "", birthday: true })),
          message: `${upgrades.map(c => first(c.childName)).join(" & ")} \u{1F382} already checked in. Now marked as the free birthday visit for ${year}.` });
      }
      return json({ error: `${already.map(c => first(c.childName)).join(" & ")} ${already.length === 1 ? "is" : "are"} already checked in at ${entry.atLabel || chosen.label}.`, already: true }, 409);
    }

    const entryId = entry ? entry.id : crypto.randomUUID();
    const isNewEntry = !entry;
    if (!entry) {
      const pc = cards[0];
      const adultsOnFile = Array.isArray(pc.waiverAdults) ? pc.waiverAdults.map(a => (a && a.name) || a).filter(Boolean) : [];
      entry = { id: entryId, type: "walkin", source: "profile", children: 0, adults: adultCount, at: atISO, atLabel,
        waiverConfirmed, waiverConfirmedAt: waiverConfirmed ? atISO : null,
        parentName: String(pc.parentName || adultsOnFile[0] || "").slice(0, 80),
        familyKey: famKey, childNames: [], profileCodes: [], birthdayNames: [], birthdayCodes: [], playClubCode: null };
    } else {
      entry.adults = Math.max(entry.adults || 0, adultCount);
    }

    // Visit history on each child's profile (tagged with this roster row so a
    // Remove takes it back off), and the birthday visit marked used.
    const done = [];
    for (const card of fresh) {
      const isBday = bdaySet.has(card.code);
      const r = await addPunch(loyalty, { code: card.code, noPunch: isBday, birthdayYear: isBday ? year : null,
        visitMeta: { date, source: isBday ? "birthday" : "walkin", slotLabel: chosen.label, bookingId: entryId,
          admission: isBday ? "birthday" : "regular", birthday: isBday, walkin: true } });
      if (r && r.error) return json({ error: "Couldn't save the visit. Try again." }, 502);
      if (isBday) {
        await markBirthdayUsed({ loyaltyCodes: [card.code], childName: card.childName, dob: card.dob || "", year,
          usedBy: "desk", reason: "Free birthday visit at the desk" });
        entry.birthdayNames.push(card.childName || card.code);
        entry.birthdayCodes.push(card.code);
      }
      entry.childNames.push(card.childName || card.code);
      entry.profileCodes.push(card.code);
      done.push({ code: card.code, childName: card.childName || "", birthday: isBday });
    }
    entry.children = (entry.children || 0) + fresh.length;
    if (isNewEntry) rec.bookings.push(entry);
    rec.children = (rec.children || 0) + fresh.length;
    try { await bookings.setJSON(key, rec); } catch { return json({ error: "Couldn't update the roster. Try again." }, 502); }

    const hourKids = await countHourChildren(bookings, date, slot);
    const names = done.map(d => first(d.childName) + (d.birthday ? " \u{1F382}" : "")).join(", ");
    return json({
      ok: true, slot, slotLabel: chosen.label, atLabel, entryId, checkedIn: done, merged: !isNewEntry,
      children: hourKids, cap, remaining: Math.max(0, cap - hourKids), over: hourKids > cap,
      message: `Checked in ${names} → ${chosen.label}` +
        (done.some(d => d.birthday) ? " · free birthday visit used for " + year : "") +
        (isNewEntry ? ` · ${entry.adults} adult${entry.adults === 1 ? "" : "s"}` : " · added to their family on the roster") + ".",
    });
  }

  // ---- WALK-IN ----
  if (action === "walkin") {
    const count = Math.max(1, parseInt(b.count, 10) || 0);
    if (count < 1) return json({ error: "Enter how many children walked in." }, 400);
    const adultCount = Math.max(0, parseInt(b.adults, 10) || 0);
    // Optional Play Club details. Purely additive -- a plain walk-in sends
    // neither field and behaves exactly as before. When staff check a member in
    // from the Play Club search, the child names and membership code ride along
    // so the roster shows WHO walked in, not just a headcount.
    const childNames = Array.isArray(b.childNames)
      ? b.childNames.map(n => String(n || "").trim()).filter(Boolean).slice(0, 10)
      : [];
    const playClubCode = (b.playClubCode || "").toString().trim().toUpperCase().slice(0, 24) || null;

    const entryId = crypto.randomUUID();
    const rec = await addToSession(bookings, key, {
      id: entryId, type: "walkin", children: count, adults: adultCount, at: atISO, atLabel,
      waiverConfirmed, waiverConfirmedAt: waiverConfirmed ? atISO : null,
      childNames, playClubCode,
    });
    const hourKids = await countHourChildren(bookings, date, slot);   // whole hour (:00 + :30), not just this slot
    return json({
      ok: true, slot, slotLabel: chosen.label, atLabel,
      children: hourKids, cap, remaining: Math.max(0, cap - hourKids), over: hourKids > cap,
      message: `Logged ${count} walk-in child${count === 1 ? "" : "ren"}${adultCount ? ` + ${adultCount} adult${adultCount === 1 ? "" : "s"}` : ""} at ${atLabel} → ${chosen.label}.`,
    });
  }

  return json({ error: "Unknown action." }, 400);
};

// Online bookings today that include these children (matched by name). Each
// result: { key, rec, entry, arrivalLabel }, keyed by the child's profile code.
async function onlineBookingsFor(bookings, date, cards) {
  const found = new Map();
  let keys = [];
  try { keys = await listAllKeys(bookings, { prefix: date + "__" }); } catch { return found; }
  for (const key of keys) {
    let rec = null; try { rec = await bookings.get(key, { type: "json", consistency: "strong" }); } catch {}
    if (!rec || !Array.isArray(rec.bookings)) continue;
    for (const entry of rec.bookings) {
      if (!entry || entry.type === "walkin" || entry.type === "pass" || !Array.isArray(entry.childNames)) continue;
      const names = entry.childNames.map(c => childNameKey(typeof c === "string" ? c : ((c && c.first || "") + " " + (c && c.last || ""))));
      for (const card of cards) {
        if (found.has(card.code)) continue;
        if (names.includes(childNameKey(card.childName))) found.set(card.code, { key, rec, entry, arrivalLabel: (ARRIVAL[key.split("__")[1]] || {}).label || "" });
      }
    }
  }
  return found;
}

// Reverse a profile check-in: remove the visit it added to each child's history,
// and if it used up a birthday visit, give that back (and un-retire the codes it
// retired) so a mis-click doesn't cost the child their birthday visit.
async function undoProfileVisits(entry, date) {
  const loyalty = getStore("loyalty");
  const year = String(date).slice(0, 4);
  for (const code of entry.profileCodes) {
    let card = null; try { card = await loyalty.get("card:" + code, { type: "json", consistency: "strong" }); } catch {}
    if (!card) continue;
    const before = Array.isArray(card.visits) ? card.visits.length : 0;
    card.visits = (card.visits || []).filter(v => v.bookingId !== entry.id);
    if (card.visits.length < before) card.totalVisits = Math.max(0, (card.totalVisits || 0) - (before - card.visits.length));
    card.history = Array.isArray(card.history) ? card.history : [];
    card.history.push({ at: new Date().toISOString(), action: "checkin-removed", note: "Desk check-in removed from the roster" });
    try { await loyalty.setJSON("card:" + code, card); } catch {}
    if ((entry.birthdayCodes || []).includes(code)) {
      const sameKid = await findChildCards(loyalty, { code, childName: card.childName, dob: card.dob || "" }).catch(() => []);
      for (const c of sameKid) {
        if (c.birthdayUsedYear !== year) continue;
        delete c.birthdayUsedYear; delete c.birthdayUsedAt;
        // Leave lastSentYear alone if a code was really emailed; otherwise reopen it.
        if (!c.lastCode) { delete c.lastSentYear; delete c.dayOfSentYear; }
        try { await loyalty.setJSON("card:" + c.code, c); } catch {}
      }
      try {
        const rewards = getStore("rewards");
        const { listAllKeys } = await import("./lib-blobs.js");
        for (const k of await listAllKeys(rewards, { prefix: "reward:" })) {
          let r = null; try { r = await rewards.get(k, { type: "json" }); } catch { continue; }
          if (r && r.kind === "birthday" && r.voidedReason === "Free birthday visit at the desk" &&
              String(r.validFrom || "").slice(0, 4) === year &&
              (r.loyaltyCode === code || String(r.childName || "").toLowerCase().trim() === String(card.childName || "").toLowerCase().trim())) {
            r.used = false; delete r.usedAt; delete r.usedBy; delete r.voidedReason;
            try { await rewards.setJSON(k, r); } catch {}
          }
        }
      } catch {}
    }
  }
}

async function addToSession(bookings, key, entry) {
  let rec = null; try { rec = await bookings.get(key, { type: "json", consistency: "strong" }); } catch {}
  if (!rec || typeof rec.children !== "number") rec = { children: 0, bookings: [] };
  rec.bookings = Array.isArray(rec.bookings) ? rec.bookings : [];
  rec.bookings.push(entry);
  rec.children = (rec.children || 0) + (entry.children || 0);
  try { await bookings.setJSON(key, rec); } catch {}
  return rec;
}

async function bookedParties(date) {
  const parties = getStore("parties");
  const ids = [];
  for (const pid of PARTY_SLOT_IDS) {
    try { if (await parties.get(slotKey(date, pid), { type: "json" })) ids.push(pid); } catch {}
  }
  return ids;
}

function pacificDate() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }
function pacificMinutes() {
  const hm = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false });
  const [h, m] = hm.split(":").map(n => parseInt(n, 10));
  return h * 60 + m;
}
function pacificClock() {
  return new Date().toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/checkin" };
