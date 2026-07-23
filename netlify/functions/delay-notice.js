// POST /api/delay-notice
// Staff sets/clears a "delayed admission" notice for a specific arrival slot today.
// Saved to "site" blob as "delayNotice" so capacity.js can read it.
//
//   { key, action:"set", slot:"arr12", until:"12:30" }  -> sets notice
//   { key, action:"clear" }                             -> removes notice
//   { action:"get" }                                    -> returns current notice (no key needed)

import { getStore } from "@netlify/blobs";

const STAFF_PIN  = process.env.STAFF_PIN  || "";
const ADMIN_KEY  = process.env.ADMIN_KEY  || "";

function pacificDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }

  const site = getStore("site");
  const action = (b.action || "get").toString();

  if (action === "get") {
    let n = null;
    try { n = await site.get("delayNotice", { type: "json" }); } catch {}
    // Auto-expire: if notice is for a past date or the until time has passed, ignore it
    if (n && !isActive(n)) n = null;
    return json({ ok: true, notice: n || null });
  }

  // write actions require auth
  const key = (b.key || "").toString().trim();
  if (!key || (key !== ADMIN_KEY && key !== STAFF_PIN)) return json({ error: "Not authorised." }, 403);

  if (action === "clear") {
    try { await site.delete("delayNotice"); } catch {}
    return json({ ok: true, cleared: true });
  }

  if (action === "set") {
    const slot  = (b.slot  || "").toString().trim();  // e.g. "arr12"
    const until = (b.until || "").toString().trim();  // e.g. "12:30"
    if (!slot || !until) return json({ error: "slot and until are required." }, 400);
    const notice = { slot, until, date: pacificDate(), setAt: new Date().toISOString() };
    try { await site.setJSON("delayNotice", notice); } catch { return json({ error: "Couldn't save." }, 502); }
    return json({ ok: true, notice });
  }

  return json({ error: "Unknown action." }, 400);
};

function isActive(n) {
  if (!n || !n.date || !n.until) return false;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  if (n.date !== today) return false;
  // parse "HH:MM" until time
  const [hh, mm] = (n.until || "0:0").split(":").map(Number);
  const now = new Date();
  const ptNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const untilMins = hh * 60 + mm;
  const nowMins   = ptNow.getHours() * 60 + ptNow.getMinutes();
  return nowMins < untilMins;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/delay-notice" };
