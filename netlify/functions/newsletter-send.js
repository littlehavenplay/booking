// POST /api/newsletter-send  (admin key or staff PIN)
// Compose a newsletter to all active subscribers.
// Body: {
//   key,
//   subject, message,               // required
//   image?  (data URL),             // optional promo/event photo
//   bookLink? (string|false),       // optional call-to-action button target
//   sendNow (bool),                 // true = send immediately
//   scheduledAt (ISO or epoch ms)   // when sendNow is false
// }
//
// Campaigns are delivered as Resend BROADCASTS (marketing quota — billed by
// contacts stored, unlimited sends) rather than looping the transactional
// endpoint, which is capped at 100 emails a day and would take booking
// confirmations down with it. See lib-newsletter.js for the full explanation.
import { getStore } from "@netlify/blobs";
import { STORE, runCampaign } from "./lib-newsletter.js";

// How long "Send now" is willing to wait for Resend to ingest the subscriber
// list before handing off to the 15-minute cron. Netlify gives a synchronous
// function ~10s, so stay well inside that.
const SEND_NOW_BUDGET_MS = 5500;

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
    // "syncing" is the first step of the broadcast pipeline:
    //   syncing -> ready -> queued -> sent
    status: sendNow ? "syncing" : "scheduled",
    scheduledAt, sentAt: null,
    segmentId: null, importId: null, broadcastId: null, sendRequestedAt: null,
    stats: { sent: 0, failed: 0, total: 0 },
  };

  // Optional image (stored like promos: base64 bytes + mime, served by newsletter-image.js)
  if (b.image && typeof b.image === "string" && b.image.startsWith("data:")) {
    const m = b.image.match(/^data:([^;]+);base64,(.+)$/);
    if (m) { campaign.imageMime = m[1]; try { await store.set("cimg:" + id, m[2]); } catch {} }
  }

  try { await store.setJSON("campaign:" + id, campaign); }
  catch { return json({ error: "Couldn't save the campaign. Try again." }, 502); }

  if (!sendNow) {
    return json({ ok: true, id, scheduled: true, status: campaign.status,
      message: `Scheduled for ${new Date(scheduledAt).toLocaleString()}.` });
  }

  // Send now: push the campaign as far along as one request allows.
  const { last } = await runCampaign(store, campaign, { budgetMs: SEND_NOW_BUDGET_MS, maxSteps: 10 });

  if (last && last.error === "email-not-configured") {
    return json({ error: "Email isn't configured yet (RESEND_API_KEY). The campaign was saved but nothing was sent." }, 502);
  }
  if (campaign.status === "failed") {
    return json({ error: campaign.lastError || "The campaign couldn't be sent." , id, status: "failed" }, 502);
  }

  const total = (campaign.stats && campaign.stats.total) || 0;
  let msg;
  if (campaign.status === "sent") {
    msg = `Sent to ${total} subscriber${total === 1 ? "" : "s"}! 🎉`;
  } else if (campaign.status === "queued") {
    msg = `Handed to Resend — going out to ${total} subscriber${total === 1 ? "" : "s"} now. 🎉 The status here updates within ~15 minutes.`;
  } else {
    msg = `Preparing your subscriber list… it'll go out automatically within ~15 minutes. Nothing more to do.`;
  }

  return json({ ok: true, id, status: campaign.status, total, sent: campaign.stats.sent || 0,
    complete: campaign.status === "sent", message: msg });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/newsletter-send" };
