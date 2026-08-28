// POST /api/newsletter-send  (admin key or staff PIN)
// Compose a newsletter to all active subscribers.
// Body: {
//   key,
//   subject, message,               // required
//   image?  (data URL),             // optional promo/event photo
//   bookLink? (string|false),       // optional "Book your visit" button target
//   sendNow (bool),                 // true = send immediately
//   scheduledAt (ISO or epoch ms)   // when sendNow is false
// }
import { getStore } from "@netlify/blobs";
import { STORE, sendCampaignBatch } from "./lib-newsletter.js";

const INLINE_BATCHES = 3; // "send now" pushes up to 3×100 recipients in this request; cron finishes any remainder

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const subject = String(b.subject || "").trim().slice(0, 200);
  const message = String(b.message || "").trim().slice(0, 8000);
  if (!subject) return json({ error: "Add a subject line." }, 400);
  if (!message) return json({ error: "Write a message first." }, 400);

  const sendNow = !!b.sendNow;
  let scheduledAt = null;
  if (!sendNow) {
    const t = typeof b.scheduledAt === "number" ? b.scheduledAt : Date.parse(b.scheduledAt || "");
    if (!t || isNaN(t)) return json({ error: "Pick a valid date & time to schedule." }, 400);
    if (t < Date.now() - 60000) return json({ error: "That time is in the past — pick a future time or choose Send now." }, 400);
    scheduledAt = new Date(t).toISOString();
  }

  let bookLink = null;
  if (b.bookLink !== false && b.bookLink !== "") {
    bookLink = String(b.bookLink || "https://littlehavenplay.com/book.html").slice(0, 300);
  }
  // Blank means "work it out from the link" — see defaultButtonLabel().
  const bookLabel = String(b.bookLabel || "").slice(0, 40).trim();

  const store = getStore(STORE);
  const id = (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)));

  const campaign = {
    id, subject, message, bookLink, bookLabel,
    imageMime: null,
    createdAt: new Date().toISOString(),
    status: sendNow ? "sending" : "scheduled",
    scheduledAt, sentAt: null,
    done: [], stats: { sent: 0, failed: 0, total: 0 },
  };

  // Optional image (stored like promos: base64 bytes + mime, served by newsletter-image.js)
  if (b.image && typeof b.image === "string" && b.image.startsWith("data:")) {
    const m = b.image.match(/^data:([^;]+);base64,(.+)$/);
    if (m) { campaign.imageMime = m[1]; try { await store.set("cimg:" + id, m[2]); } catch {} }
  }

  try { await store.setJSON("campaign:" + id, campaign); }
  catch { return json({ error: "Couldn't save the campaign. Try again." }, 502); }

  if (!sendNow) {
    return json({ ok: true, id, scheduled: true, message: `Scheduled for ${new Date(scheduledAt).toLocaleString()}.` });
  }

  // Send now: push several batches inline; the cron picks up any remainder.
  let processed = 0, remaining = 0, complete = false;
  for (let i = 0; i < INLINE_BATCHES; i++) {
    const r = await sendCampaignBatch(store, campaign, { max: 100 });
    processed += r.processed; remaining = r.remaining; complete = r.complete;
    try { await store.setJSON("campaign:" + id, campaign); } catch {}
    if (r.error === "email-not-configured") {
      return json({ error: "Email isn't configured yet (RESEND_API_KEY / EMAIL_FROM). The campaign was saved but nothing was sent." }, 502);
    }
    if (complete || r.processed === 0) break;
  }

  const msg = complete
    ? `Sent to ${campaign.stats.sent} subscriber${campaign.stats.sent === 1 ? "" : "s"}! 🎉`
    : `Sending… ${campaign.stats.sent} sent so far, ${remaining} still going out (they'll finish automatically within ~15 min).`;
  return json({ ok: true, id, sent: campaign.stats.sent, remaining, complete, message: msg });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/newsletter-send" };
