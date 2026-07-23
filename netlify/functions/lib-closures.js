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
