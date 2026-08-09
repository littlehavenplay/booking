// POST /api/newsletter-subscribe  (public)
// Body: { email, name? }  -> adds/reactivates a newsletter subscriber.
// Idempotent: subscribing again just keeps them active. If they'd previously
// unsubscribed, opting in again here (an explicit action) re-activates them.
import { newsletterStore, cleanEmail, validEmail, subKey } from "./lib-newsletter.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const email = cleanEmail(b.email);
  if (!validEmail(email)) return json({ error: "Please enter a valid email address." }, 400);
  const name = String(b.name || "").trim().slice(0, 80);

  const store = newsletterStore();
  let existing = null;
  try { existing = await store.get(subKey(email), { type: "json" }); } catch {}

  const rec = existing || {
    email,
    token: (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))),
    subscribedAt: new Date().toISOString(),
  };
  if (name) rec.name = name;
  const wasInactive = existing && existing.active === false;
  rec.active = true;
  if (wasInactive) { rec.resubscribedAt = new Date().toISOString(); delete rec.unsubscribedAt; }
  rec.source = rec.source || String(b.source || "site-popup").slice(0, 40);

  try { await store.setJSON(subKey(email), rec); }
  catch { return json({ error: "Couldn't save right now — please try again." }, 502); }

  return json({ ok: true, message: "You're on the list! 🎉" });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/newsletter-subscribe" };
