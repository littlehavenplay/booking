// POST /api/newsletter-admin  (admin key or staff PIN)
//   action "list"            -> { subscribers:[…active…], counts, campaigns:[…] }
//   action "remove-sub"      -> { email }  hard-delete one subscriber
//   action "delete-campaign" -> { id }     remove a scheduled/sent campaign
//   action "export"          -> { csv }    CSV of active subscribers
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { STORE, cleanEmail, subKey } from "./lib-newsletter.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore(STORE);
  const action = (b.action || "").toString();

  if (action === "list") {
    const subKeys = await listAllKeys(store, { prefix: "sub:" });
    const subscribers = []; let unsubscribed = 0;
    for (const k of subKeys) {
      let s = null; try { s = await store.get(k, { type: "json" }); } catch {}
      if (!s || !s.email) continue;
      if (s.active === false) { unsubscribed++; continue; }
      subscribers.push({ email: s.email, name: s.name || "", subscribedAt: s.subscribedAt || "", source: s.source || "" });
    }
    subscribers.sort((a, c) => (c.subscribedAt || "").localeCompare(a.subscribedAt || ""));

    const campKeys = await listAllKeys(store, { prefix: "campaign:" });
    const campaigns = [];
    for (const k of campKeys) {
      let c = null; try { c = await store.get(k, { type: "json" }); } catch {}
      if (!c) continue;
      campaigns.push({
        id: c.id, subject: c.subject || "", status: c.status || "",
        scheduledAt: c.scheduledAt || null, sentAt: c.sentAt || null,
        createdAt: c.createdAt || null, hasImage: !!c.imageMime,
        stats: c.stats || { sent: 0, total: 0 },
      });
    }
    campaigns.sort((a, c) => String(c.createdAt || "").localeCompare(String(a.createdAt || "")));

    return json({ ok: true, subscribers, counts: { active: subscribers.length, unsubscribed }, campaigns });
  }

  if (action === "remove-sub") {
    const email = cleanEmail(b.email);
    if (!email) return json({ error: "No email given." }, 400);
    try { await store.delete(subKey(email)); } catch {}
    return json({ ok: true, message: "Removed." });
  }

  if (action === "delete-campaign") {
    const id = (b.id || "").toString();
    if (!id) return json({ error: "No campaign id." }, 400);
    try { await store.delete("campaign:" + id); } catch {}
    try { await store.delete("cimg:" + id); } catch {}
    return json({ ok: true, message: "Deleted." });
  }

  if (action === "export") {
    const subKeys = await listAllKeys(store, { prefix: "sub:" });
    const rows = [["name", "email", "subscribed_at", "source"]];
    for (const k of subKeys) {
      let s = null; try { s = await store.get(k, { type: "json" }); } catch {}
      if (!s || !s.email || s.active === false) continue;
      rows.push([s.name || "", s.email, s.subscribedAt || "", s.source || ""]);
    }
    const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    return json({ ok: true, csv, total: rows.length - 1 });
  }

  return json({ error: "Unknown action." }, 400);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/newsletter-admin" };
