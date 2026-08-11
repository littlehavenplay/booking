// /api/party-off   (protected by ADMIN_KEY or STAFF_PIN)
// Manages the "open play only — no parties" control. Open play is never affected.
//   GET  ?key=...                          -> { ok, weekdays, ranges }
//   POST { key, action:"addRange", from, to, note }
//   POST { key, action:"removeRange", id }
//   POST { key, action:"setWeekdays", weekdays:[0-6] }
// Stored in the "site" store under "partyOff".

import { getStore } from "@netlify/blobs";
import { loadPartyOff } from "./lib-settings.js";

const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async (req) => {
  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const authed = (v) => (adminKey || staffPin) && (v === adminKey || v === staffPin);
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured. Set ADMIN_KEY in Netlify." }, 500);

  // ---- GET: read current settings ----
  if (req.method === "GET") {
    const url = new URL(req.url);
    if (!authed((url.searchParams.get("key") || "").toString())) return json({ error: "Wrong key." }, 401);
    const cfg = await loadPartyOff();
    return json({ ok: true, ...cfg });
  }

  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  if (!authed((b.key || "").toString())) return json({ error: "Wrong key." }, 401);

  const site = getStore("site");
  const cfg = await loadPartyOff();
  const action = (b.action || "").trim();

  if (action === "addRange") {
    const from = (b.from || "").trim();
    const to = (b.to || b.from || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return json({ error: "Pick a valid start (and end) date." }, 400);
    const lo = from <= to ? from : to;
    const hi = from <= to ? to : from;
    const note = (b.note || "").toString().slice(0, 120).trim();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    cfg.ranges.push({ id, from: lo, to: hi, note });
    cfg.ranges.sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0));
    if (!(await save(site, cfg))) return json({ error: "Couldn't save. Try again." }, 502);
    return json({ ok: true, ...cfg, message: lo === hi
      ? `Parties are now OFF on ${lo} — open play only.`
      : `Parties are now OFF ${lo} → ${hi} — open play only.` });
  }

  if (action === "removeRange") {
    const id = (b.id || "").toString();
    const before = cfg.ranges.length;
    cfg.ranges = cfg.ranges.filter(r => r.id !== id);
    if (cfg.ranges.length === before) return json({ error: "That entry was already removed." }, 404);
    if (!(await save(site, cfg))) return json({ error: "Couldn't save. Try again." }, 502);
    return json({ ok: true, ...cfg, message: "Removed — parties are allowed again on those dates." });
  }

  if (action === "setWeekdays") {
    const wd = Array.isArray(b.weekdays)
      ? [...new Set(b.weekdays.map(n => parseInt(n, 10)).filter(n => n >= 0 && n <= 6))].sort((a, c) => a - c)
      : [];
    cfg.weekdays = wd;
    if (!(await save(site, cfg))) return json({ error: "Couldn't save. Try again." }, 502);
    const msg = wd.length ? `Standing rule saved: no parties on ${wd.map(d => WD[d]).join(", ")}.` : "Standing weekday rule cleared.";
    return json({ ok: true, ...cfg, message: msg });
  }

  return json({ error: "Unknown action." }, 400);
};

async function save(site, cfg) {
  try { await site.setJSON("partyOff", cfg); return true; } catch { return false; }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/party-off" };
