import { getStore } from "@netlify/blobs";

// Reads the seasonal-hours override (set by admin/staff). Returns null if unset.
// Shape: { active, from:"YYYY-MM-DD", to:"YYYY-MM-DD", open:<min>, close:<min>, label }
export async function loadSeasonal() {
  try { return (await getStore("site").get("seasonal-hours", { type: "json" })) || null; }
  catch { return null; }
}

// Reads the standing Weekly per-day schedule (set by admin/staff). Returns null if unset.
// Shape: { "0":{open:<min>,close:<min>,closed:false}, ... "6":{...} }  (0=Sun ... 6=Sat)
export async function loadWeekly() {
  try { return (await getStore("site").get("weekly-hours", { type: "json" })) || null; }
  catch { return null; }
}
