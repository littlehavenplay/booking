// Shared helpers for the newsletter / marketing-email system.
//
// Storage (Netlify Blobs store "newsletter"):
//   sub:<emailLower>        -> { email, name, token, subscribedAt, active, unsubscribedAt? }
//   campaign:<id>           -> { id, subject, message, imageMime, bookLink, createdAt,
//                                status, scheduledAt, sentAt, done:[emails], stats:{sent,failed,total} }
//   cimg:<id>               -> base64 image bytes for a campaign (served by newsletter-image.js)
//
// Emails go out through Resend (same provider the rest of the site uses). We use
// Resend's /emails/batch endpoint so each recipient gets their OWN one-click
// unsubscribe link (personalised), up to 100 per API call.

import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { SITE, SIGNATURE_HTML } from "./lib-email.js";

export const STORE = "newsletter";
export const BATCH_SIZE = 100; // Resend batch endpoint max per call

export function newsletterStore() { return getStore(STORE); }

export function cleanEmail(e) {
  return String(e || "").trim().toLowerCase().slice(0, 200);
}
export function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(e));
}
export function subKey(email) { return "sub:" + cleanEmail(email); }

export function unsubUrl(email, token) {
  return `${SITE}/api/newsletter-unsubscribe?e=${encodeURIComponent(cleanEmail(email))}&t=${encodeURIComponent(token || "")}`;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// Turn a plain-text message (with blank lines between paragraphs) into safe HTML.
function messageToHtml(message) {
  const blocks = String(message || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return blocks
    .map(b => `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2a2622">${esc(b).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Build the full HTML email for one subscriber. Includes the optional promo/event
// image, the owner's message, an optional "Book your visit" button, and a footer
// with a working one-click unsubscribe link.
export function buildCampaignHtml(campaign, subscriber) {
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const uUrl = unsubUrl(subscriber.email, subscriber.token);
  const imgTag = campaign.imageMime
    ? `<img src="${SITE}/api/newsletter-image?id=${encodeURIComponent(campaign.id)}" alt="" style="width:100%;max-width:600px;display:block;border-radius:12px;margin:0 0 18px">`
    : "";
  const hello = subscriber.name ? `Hi ${esc(subscriber.name)},` : "Hi there,";
  const bookBtn = campaign.bookLink
    ? `<div style="text-align:center;margin:22px 0 6px">
         <a href="${esc(campaign.bookLink)}" style="display:inline-block;background:#c97d76;color:#fff;text-decoration:none;font-weight:800;font-size:15px;padding:14px 30px;border-radius:40px">Book your visit →</a>
       </div>`
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#faf7f3;padding:22px 0">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #efe4d5">
      <div style="padding:24px 26px 8px">
        <p style="margin:0 0 14px;font-size:16px;color:#5c6470">${hello}</p>
        ${imgTag}
        ${messageToHtml(campaign.message)}
        ${bookBtn}
      </div>
      <div style="padding:0 26px">${SIGNATURE_HTML}</div>
      <div style="padding:16px 26px 24px;color:#9a8d80;font-size:12px;line-height:1.6;text-align:center">
        You're getting this because you opted in to promotions &amp; event updates from ${esc(studio)}.
        We only email occasionally &mdash; never spam.<br>
        <a href="${uUrl}" style="color:#a85f59;font-weight:700">Unsubscribe instantly</a> &middot; you'll be removed right away.
      </div>
    </div>
  </div>`;
}

// Fetch active subscribers (paginated).
export async function listActiveSubscribers(store) {
  const keys = await listAllKeys(store, { prefix: "sub:" });
  const out = [];
  for (const k of keys) {
    let s = null; try { s = await store.get(k, { type: "json" }); } catch {}
    if (s && s.active !== false && s.email) out.push(s);
  }
  return out;
}

// Send the next chunk of a campaign to subscribers who haven't received it yet.
// Marks progress on the campaign record so re-runs never double-send. Returns
// { processed, remaining, complete }.
export async function sendCampaignBatch(store, campaign, { max = BATCH_SIZE } = {}) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const replyTo = process.env.STUDIO_EMAIL || "hello@littlehavenplay.com";
  if (!key) return { processed: 0, remaining: 0, complete: true, error: "email-not-configured" };

  const done = new Set(Array.isArray(campaign.done) ? campaign.done : []);
  const subs = await listActiveSubscribers(store);
  const pending = subs.filter(s => !done.has(cleanEmail(s.email)));
  campaign.stats = campaign.stats || { sent: 0, failed: 0, total: 0 };
  campaign.stats.total = subs.length;

  const chunk = pending.slice(0, Math.min(max, BATCH_SIZE));
  if (!chunk.length) {
    campaign.status = "sent";
    campaign.sentAt = campaign.sentAt || new Date().toISOString();
    return { processed: 0, remaining: 0, complete: true };
  }

  const payload = chunk.map(s => ({
    from: `${studio} <${from}>`,
    to: [s.email],
    reply_to: replyTo,
    subject: campaign.subject,
    html: buildCampaignHtml(campaign, s),
    headers: {
      "List-Unsubscribe": `<${unsubUrl(s.email, s.token)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  }));

  let ok = false;
  try {
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    ok = res.ok;
  } catch { ok = false; }

  if (ok) {
    for (const s of chunk) { done.add(cleanEmail(s.email)); campaign.stats.sent++; }
  } else {
    campaign.stats.failed += chunk.length; // leave them un-done so a later run retries
  }

  campaign.done = [...done];
  const remaining = subs.filter(s => !done.has(cleanEmail(s.email))).length;
  if (remaining === 0 && ok) {
    campaign.status = "sent";
    campaign.sentAt = new Date().toISOString();
  } else {
    campaign.status = "sending";
  }
  return { processed: ok ? chunk.length : 0, remaining, complete: remaining === 0 && ok };
}
