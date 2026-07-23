// POST /api/event-admin  (admin key or staff PIN)
// Body: { key, action, ... }
//   action "list"    -> all events (admin view)
//   action "save"    -> { id?, title, description, dateTime, price (dollars), capacity, poster? (data URL) }
//   action "delete"  -> { id }
//   action "release" -> { id, count }   (free up tickets after a refund)
//   action "roster"  -> { id }          (who bought)
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("events");
  const action = (b.action || "").toString();

  if (action === "list") {
    let keys = [];
    try { const r = await store.list({ prefix: "event:" }); keys = (r.blobs || []).map(x => x.key); } catch {}
    const events = [];
    for (const k of keys) {
      let e = null; try { e = await store.get(k, { type: "json" }); } catch {}
      if (e) events.push({ id: e.id, title: e.title, description: e.description || "", requirements: e.requirements || "", regClose: e.regClose || "", waiverLink: e.waiverLink || "", regularWaiverLink: e.regularWaiverLink || "", dateTime: e.dateTime, price: e.price, siblingPrice: e.siblingPrice || 0, capacity: e.capacity, sold: e.sold || 0, hasPoster: !!e.posterMime, hidden: !!e.hidden, past: new Date(e.dateTime).getTime() < Date.now() });
    }
    events.sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime));
    return json({ ok: true, events });
  }

  if (action === "save") {
    const id = (b.id || crypto.randomUUID()).toString();
    const title = (b.title || "").toString().slice(0, 140).trim();
    const description = (b.description || "").toString().slice(0, 4000).trim();
    const dateTime = (b.dateTime || "").toString();
    const price = Math.max(0, Math.round(parseFloat(b.price) * 100) || 0);
    const siblingPrice = (b.siblingPrice === undefined || b.siblingPrice === null || b.siblingPrice === "")
      ? 0 : Math.max(0, Math.round(parseFloat(b.siblingPrice) * 100) || 0);
    const capacity = Math.max(1, parseInt(b.capacity, 10) || 0);
    if (!title) return json({ error: "Enter an event title." }, 400);
    if (!dateTime || isNaN(new Date(dateTime).getTime())) return json({ error: "Enter a valid date & time." }, 400);

    let existing = null;
    try { existing = await store.get("event:" + id, { type: "json" }); } catch {}
    const sold = existing ? (existing.sold || 0) : 0;
    if (capacity < sold) return json({ error: `Capacity can't be below tickets already sold (${sold}).` }, 400);

    const rec = {
      id, title, description, requirements: (b.requirements || "").toString().slice(0, 3000), regClose: (b.regClose || "").toString().slice(0, 20),
      waiverLink: (b.waiverLink || "").toString().slice(0, 400).trim(),
      regularWaiverLink: (b.regularWaiverLink || "").toString().slice(0, 400).trim(),
      dateTime, price, siblingPrice, capacity, sold,
      buyers: existing ? (existing.buyers || []) : [],
      posterMime: existing ? existing.posterMime || null : null,
      hidden: existing ? !!existing.hidden : false,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
    };

    // Optional poster (data URL: "data:image/jpeg;base64,....")
    if (b.poster && typeof b.poster === "string" && b.poster.startsWith("data:")) {
      const m = b.poster.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        rec.posterMime = m[1];
        try { await store.set("poster:" + id, m[2]); } catch {}
      }
    }
    try { await store.setJSON("event:" + id, rec); }
    catch { return json({ error: "Couldn't save the event. Try again." }, 502); }
    return json({ ok: true, id, message: "Event saved." });
  }

  if (action === "delete") {
    const id = (b.id || "").toString();
    try { await store.delete("event:" + id); } catch {}
    try { await store.delete("poster:" + id); } catch {}
    return json({ ok: true, message: "Event deleted." });
  }

  if (action === "release") {
    const id = (b.id || "").toString();
    const count = Math.max(1, parseInt(b.count, 10) || 0);
    let e = null; try { e = await store.get("event:" + id, { type: "json" }); } catch {}
    if (!e) return json({ error: "Event not found." }, 404);
    e.sold = Math.max(0, (e.sold || 0) - count);
    try { await store.setJSON("event:" + id, e); } catch { return json({ error: "Couldn't update. Try again." }, 502); }
    return json({ ok: true, message: `Released ${count} ticket${count === 1 ? "" : "s"}. ${e.sold} now sold.` });
  }

  if (action === "roster") {
    const id = (b.id || "").toString();
    let e = null; try { e = await store.get("event:" + id, { type: "json" }); } catch {}
    if (!e) return json({ error: "Event not found." }, 404);
    return json({ ok: true, title: e.title, dateTime: e.dateTime, sold: e.sold || 0, capacity: e.capacity, buyers: e.buyers || [] });
  }

  return json({ error: "Unknown action." }, 400);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/event-admin" };
