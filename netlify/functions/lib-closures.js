// Shared helpers for date/time closures set from the admin/staff page.
// Stored in the "site" store under key "closures":
//   { "2026-06-15": { type:"full" },
//     "2026-06-16": { type:"early", cutoff:720, note:"Closing at 12 PM" },   // block sessions still running at 12:00
//     "2026-06-17": { type:"late",  cutoff:720, note:"Opening at 12 PM" } }   // block sessions before 12:00
// cutoff = minutes since midnight (e.g. 12:00 PM = 720).
import { getStore } from "@netlify/blobs";
import { OPENPLAY, ARRIVAL } from "./lib-settings.js";

export async function getClosures() {
  try { return (await getStore("site").get("closures", { type: "json" })) || {}; }
  catch { return {}; }
}

export async function getClosure(date) {
  const all = await getClosures();
  return all[date] || null;
}

// Returns true if this session is blocked by the given closure rule.
// "early" = LAST ADMISSION at cutoff -> block sessions that START after the cutoff
//           (a session that starts at/before the cutoff stays bookable).
// "late"  = OPENING at cutoff       -> block sessions that START before the cutoff.
export function slotBlockedByClosure(closure, slotId) {
  if (!closure) return false;
  if (closure.type === "full") return true;
  const o = ARRIVAL[slotId] || OPENPLAY[slotId];
  if (!o) return false;
  if (closure.type === "early") return o.start > closure.cutoff;  // last admission = cutoff
  if (closure.type === "late")  return o.start < closure.cutoff;  // opens at cutoff
  return false;
}

// Filters a day's sessions by the closure; returns the allowed sessions + flags.
export function applyClosure(closure, slots) {
  if (!closure) return { slots, closedAllDay: false, message: "" };
  if (closure.type === "full") return { slots: [], closedAllDay: true, message: closure.note || "Closed this day." };
  const keep = slots.filter(s => !slotBlockedByClosure(closure, s.id));
  return { slots: keep, closedAllDay: keep.length === 0, message: closure.note || "", partial: keep.length !== slots.length };
}

// "12:00 PM" style label from minutes-since-midnight
export function minutesToLabel(min) {
  let h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ap}`;
}

// ---- Automatic open-play hold for event days ----
// When an event exists on a date, open play is held 2.5h before the earliest event
// that day (last admission = eventStart − 150 min). Maintained by event-admin so the
// booking page (capacity.js / book.js) only does one cheap read.
const EVENT_HOLD_LEAD_MIN = 150;   // 2.5 hours

export async function getEventHolds() {
  try { return (await getStore("site").get("eventHolds", { type: "json" })) || {}; }
  catch { return {}; }
}
export async function getEventHold(date) {
  const all = await getEventHolds();
  return all[date] || null;   // { cutoff, startLabel, lastAdmitLabel, title, count }
}

// Rebuild the date -> hold map from all current (upcoming, visible) events.
// Earliest event on a day drives that day's cutoff. Call after any event change.
export async function rebuildEventHolds() {
  const store = getStore("events");
  let keys = [];
  try { const r = await store.list({ prefix: "event:" }); keys = (r.blobs || []).map(b => b.key); } catch {}
  const now = Date.now();
  const byDate = {};
  for (const k of keys) {
    let e = null; try { e = await store.get(k, { type: "json" }); } catch {}
    if (!e || !e.dateTime || e.hidden) continue;
    const t = new Date(e.dateTime).getTime();
    if (isNaN(t) || t < now) continue;                       // ignore past/invalid
    const d = new Date(e.dateTime);
    const dateStr = d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const hm = d.toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour12: false }).slice(0, 5).split(":").map(Number);
    const startMin = hm[0] * 60 + hm[1];
    (byDate[dateStr] = byDate[dateStr] || []).push({ startMin, title: e.title || "our event" });
  }
  const holds = {};
  for (const [dateStr, list] of Object.entries(byDate)) {
    list.sort((a, b) => a.startMin - b.startMin);
    const startMin = list[0].startMin;
    const cutoff = startMin - EVENT_HOLD_LEAD_MIN;
    holds[dateStr] = { cutoff, startLabel: minutesToLabel(startMin), lastAdmitLabel: minutesToLabel(cutoff), title: list[0].title, count: list.length };
  }
  try { await getStore("site").setJSON("eventHolds", holds); } catch {}
  return holds;
}
