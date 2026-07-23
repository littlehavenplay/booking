// POST /api/hours  (admin key or staff PIN)
// Per-day hours: a standing Weekly schedule + an optional Seasonal date-range override.
// Each schedule is { "0":{open,close,closed}, ... "6":{...} }  (0=Sun ... 6=Sat), minutes from midnight.
//   { action:"public" }                                  // no key — website read
//   { key, action:"get" }                                // both schedules
//   { key, action:"saveWeekly", schedule }               // standing weekly hours
//   { key, action:"clearWeekly" }                        // back to built-in defaults
//   { key, action:"save", from, to, label?, schedule }   // seasonal override on
//   { key, action:"clear" }                              // seasonal override off
import { getStore } from "@netlify/blobs";
import { fmtClock } from "./lib-settings.js";

const DAYNAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const site = getStore("site");
  const action = (b.action || "").toString();
  let weekly = null, seasonal = null;
  try { weekly = (await site.get("weekly-hours", { type: "json" })) || null; } catch {}
  try { seasonal = (await site.get("seasonal-hours", { type: "json" })) || null; } catch {}

  // PUBLIC read for the website (no key) — hours aren't sensitive.
  if (action === "public") {
    return json({ ok: true, weekly, seasonal, summary: summarizeSeasonal(seasonal) });
  }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  if (action === "get") {
    return json({ ok: true, weekly, seasonal, summary: summarizeSeasonal(seasonal) });
  }

  if (action === "saveWeekly") {
    const r = cleanSchedule(b.schedule);
    if (r.error) return json({ error: r.error }, 400);
    try { await site.setJSON("weekly-hours", r.schedule); } catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, weekly: r.schedule, message: "Weekly hours saved." });
  }

  if (action === "clearWeekly") {
    try { await site.delete("weekly-hours"); } catch {}
    return json({ ok: true, weekly: null, message: "Weekly hours reset to the studio defaults (9–3, 4 PM Fri/Sat, closed Wednesdays)." });
  }

  if (action === "save") {
    const from = (b.from || "").toString(), to = (b.to || "").toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json({ error: "Pick a valid start and end date." }, 400);
    if (to < from) return json({ error: "End date can't be before the start date." }, 400);
    const r = cleanSchedule(b.schedule);
    if (r.error) return json({ error: r.error }, 400);
    const label = (b.label || "Seasonal hours").toString().slice(0, 60).trim() || "Seasonal hours";
    const next = { active: true, from, to, label, schedule: r.schedule };
    try { await site.setJSON("seasonal-hours", next); } catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, seasonal: next, summary: summarizeSeasonal(next), message: `Seasonal hours on (${from} → ${to}).` });
  }

  if (action === "clear") {
    const next = seasonal ? { ...seasonal, active: false } : { active: false };
    try { await site.setJSON("seasonal-hours", next); } catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, seasonal: next, summary: summarizeSeasonal(next), message: "Seasonal hours turned off — back to your Weekly hours." });
  }

  return json({ error: "Unknown action." }, 400);
};

// Normalize & validate a 7-day schedule. Returns {schedule} or {error}.
function cleanSchedule(raw) {
  if (!raw || typeof raw !== "object") return { error: "Missing the day-by-day hours." };
  const out = {};
  let anyOpen = false;
  for (let wd = 0; wd < 7; wd++) {
    const d = raw[wd] != null ? raw[wd] : raw[String(wd)];
    if (!d || d.closed) { out[wd] = { closed: true }; continue; }
    const open = parseInt(d.open, 10), close = parseInt(d.close, 10);
    if (!Number.isFinite(open) || !Number.isFinite(close) || open < 0 || close > 1439)
      return { error: `Pick valid open and close times for ${DAYNAMES[wd]} (or mark it closed).` };
    if (close < open + 60)
      return { error: `${DAYNAMES[wd]}: closing time needs to be at least an hour after opening.` };
    out[wd] = { open, close, closed: false };
    anyOpen = true;
  }
  if (!anyOpen) return { error: "At least one day needs to be open." };
  return { schedule: out };
}

function summarizeSeasonal(s) {
  if (!s || !s.active) return "Off — using your Weekly hours.";
  return `${s.label || "Seasonal hours"}: ${s.from} → ${s.to} (day-by-day hours set).`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/hours" };
