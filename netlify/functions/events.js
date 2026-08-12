import { eventIsPast } from "./lib-closures.js";
// GET /api/events — public. Upcoming events (with live ticket counts) + past events (gallery).
import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("events");
  let keys = [];
  try { const r = await store.list({ prefix: "event:" }); keys = (r.blobs || []).map(b => b.key); } catch { keys = []; }

  const now = Date.now();
  const upcoming = [], past = [];
  for (const k of keys) {
    let e = null;
    try { e = await store.get(k, { type: "json" }); } catch { e = null; }
    if (!e || e.hidden) continue;
    const isPast = eventIsPast(e.dateTime);
    if (isPast) {
      past.push({ id: e.id, title: e.title, dateTime: e.dateTime, hasPoster: !!e.posterMime });
    } else {
      const sold = e.sold || 0;
      upcoming.push({
        id: e.id, title: e.title, description: e.description || "", requirements: e.requirements || "", regClose: e.regClose || "", regClosed: (function(){ if(!e.regClose) return false; var nowPT=new Date().toLocaleString("sv-SE",{timeZone:"America/Los_Angeles"}).slice(0,16).replace(" ","T"); return nowPT >= e.regClose; })(),
        dateTime: e.dateTime, price: e.price, siblingPrice: e.siblingPrice || 0, capacity: e.capacity,
        sold, remaining: Math.max(0, e.capacity - sold), soldOut: sold >= e.capacity,
        hasPoster: !!e.posterMime,
      });
    }
  }
  upcoming.sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));
  past.sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime));
  return json({ upcoming, past });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/events" };
