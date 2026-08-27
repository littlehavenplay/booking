// POST /api/newsletter-admin  (admin key or staff PIN)
//   action "list"            -> { subscribers:[…active…], counts, campaigns:[…] }
//   action "remove-sub"      -> { email }  hard-delete one subscriber
//   action "delete-campaign" -> { id }     remove a scheduled/sent campaign
//   action "export"          -> { csv }    CSV of active subscribers
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { STORE, cleanEmail, validEmail, subKey } from "./lib-newsletter.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore(STORE);
  const action = (b.action || "").toString();

  // ---- Bulk import ------------------------------------------------------
  // Paste a column from Excel, drop in a CSV, or type addresses. Two-step:
  // preview first so nothing is saved until you've seen the numbers.
  // { key, action:"import", text, commit:false|true, source }
  // Clear the error and put a parked campaign back in the queue.
  if (action === "retry-campaign") {
    const id = (b.id || "").toString();
    if (!id) return json({ error: "Missing campaign id." }, 400);
    let c = null; try { c = await store.get("campaign:" + id, { type: "json" }); } catch {}
    if (!c) return json({ error: "Campaign not found." }, 404);
    c.status = "sending"; c.lastError = ""; c.errorCount = 0; c.errorAlerted = false;
    try { await store.setJSON("campaign:" + id, c); } catch { return json({ error: "Couldn't save." }, 502); }
    return json({ ok: true, message: "Queued again — it'll pick up within 15 minutes from where it stopped." });
  }

  if (action === "import") {
    const raw = (b.text || "").toString();
    if (!raw.trim()) return json({ error: "Paste some email addresses first." }, 400);
    if (raw.length > 400000) return json({ error: "That's too much at once — split it into a few batches." }, 400);

    // Pull addresses out of anything: CSV rows, a pasted spreadsheet column,
    // "Name <email>", or one per line. Names are picked up when they're in the
    // same row, but an address on its own is fine.
    const rows = raw.split(/[\r\n]+/);
    const found = [];
    for (const row of rows) {
      const m = row.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
      if (!m) continue;
      const email = cleanEmail(m[0]);
      if (!validEmail(email)) continue;
      // Name = the first cell that isn't the address and isn't a phone number.
      let name = "";
      for (const cell of row.split(/[,;\t]/)) {
        const c = cell.trim().replace(/^["']|["']$/g, "");
        if (!c || c.indexOf("@") > -1) continue;
        if (/^[\d\s()+.\-]+$/.test(c)) continue;
        if (/^(name|email|phone|e-mail)$/i.test(c)) continue;
        name = c.slice(0, 80); break;
      }
      found.push({ email, name });
    }
    if (!found.length) return json({ error: "No valid email addresses found in that text." }, 400);

    // Dedupe within the paste itself — the same address twice is common.
    const uniq = new Map();
    for (const f of found) if (!uniq.has(f.email)) uniq.set(f.email, f);

    const existingKeys = new Set(await listAllKeys(store, { prefix: "sub:" }));
    const suppKeys = new Set((await listAllKeys(store, { prefix: "supp:" }).catch(() => []))
      .map(k => k.slice("supp:".length)));

    const toAdd = [], already = [], blocked = [];
    for (const [email, rec] of uniq) {
      if (suppKeys.has(email)) { blocked.push(email); continue; }   // opted out — never re-add
      if (existingKeys.has("sub:" + email)) { already.push(email); continue; }
      toAdd.push(rec);
    }

    const summary = {
      found: found.length, unique: uniq.size,
      toAdd: toAdd.length, already: already.length,
      blocked: blocked.length, invalid: found.length - uniq.size,
      sample: toAdd.slice(0, 8).map(r => r.email),
    };
    if (!b.commit) {
      return json({ ok: true, preview: true, ...summary,
        message: `${toAdd.length} new · ${already.length} already on the list · ${blocked.length} previously unsubscribed (skipped).` });
    }

    let added = 0;
    for (const rec of toAdd) {
      try {
        await store.setJSON("sub:" + rec.email, {
          email: rec.email, name: rec.name || "",
          token: (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))),
          subscribedAt: new Date().toISOString(), active: true,
          source: (b.source || "import").toString().slice(0, 40),
        });
        added++;
      } catch {}
    }
    return json({ ok: true, imported: true, ...summary, added,
      message: `Added ${added} new subscriber${added === 1 ? "" : "s"}. ${already.length} were already on the list, ${blocked.length} had unsubscribed and were skipped.` });
  }

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
        lastError: c.lastError || "", errorCount: c.errorCount || 0,
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
