// Shared helpers for the newsletter / marketing-email system.
//
// Storage (Netlify Blobs store "newsletter"):
//   sub:<emailLower>   -> { email, name, token, subscribedAt, active, unsubscribedAt? }
//   supp:<emailLower>  -> permanent opt-out record (survives re-imports)
//   campaign:<id>      -> { id, subject, message, imageMime, bookLink, createdAt,
//                           status, scheduledAt, sentAt, segmentId, importId,
//                           broadcastId, sendRequestedAt, stats:{sent,failed,total} }
//   cimg:<id>          -> base64 image bytes for a campaign
//
// HOW CAMPAIGNS SEND  (changed — read this before editing)
// --------------------------------------------------------
// Campaigns go out through Resend's MARKETING side (Broadcasts), never the
// transactional /emails or /emails/batch endpoints.
//
// The transactional free tier is capped at 100 emails A DAY and counts every
// single recipient. One blast to ~200 subscribers therefore exceeded the daily
// quota by 200% and blocked the entire account — booking confirmations, punch
// card emails, birthday codes, all of it. Marketing is billed by contacts
// stored (1,000 free) with unlimited sending, so a blast there costs nothing.
//
// The trade: Resend has to hold the recipient list, so before each send we
// upload subscribers as Contacts in a Segment. Both directions stay in sync —
// our suppressions push up, Resend's unsubscribes pull down — so neither side
// can resurrect someone who opted out.

import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { SITE, SIGNATURE_HTML, fromHeader } from "./lib-email.js";
import {
  resolveSegmentId, importContactsCsv, getImport, listSegmentContacts,
  createBroadcastDraft, sendBroadcast, getBroadcast,
  broadcastIsDone, broadcastFailed, marketingConfigured,
} from "./lib-resend-marketing.js";

export const STORE = "newsletter";

// Free marketing tier stores 1,000 contacts. Going over doesn't just cost
// money — the import starts rejecting rows, so people silently miss the email.
// Better to stop and say so.
export const CONTACT_CAP = () => Number(process.env.RESEND_CONTACT_CAP || 1000);

// A contact import that hasn't finished after this long is stuck, not slow.
const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;

export function newsletterStore() { return getStore(STORE); }

export function cleanEmail(e) {
  return String(e || "").trim().toLowerCase().slice(0, 200);
}
export function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(e));
}
export function subKey(email) { return "sub:" + cleanEmail(email); }
// A PERMANENT block, kept separately from the subscriber record. Once someone
// opts out they stay out — a later bulk import must never be able to resurrect
// them, which is both the law and the fastest way to earn a spam complaint.
export function suppressKey(email) { return "supp:" + cleanEmail(email); }

export async function isSuppressed(store, email) {
  try { return !!(await store.get(suppressKey(email), { type: "json", consistency: "strong" })); } catch { return false; }
}

export async function suppress(store, email, reason) {
  try {
    await store.setJSON(suppressKey(email), {
      email: cleanEmail(email), at: new Date().toISOString(), reason: reason || "unsubscribed",
    });
  } catch {}
}

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

// Work out a sensible button label from where the link points, so a campaign
// about referrals doesn't ship a button saying "Book your visit". Used as the
// default; whatever the studio types always wins.
export function defaultButtonLabel(url) {
  const u = (url || "").toLowerCase();
  if (u.indexOf("/refer") > -1)                                   return "Get my referral code";
  if (u.indexOf("/part") > -1)                                    return "See party packages";
  if (u.indexOf("/event") > -1 || u.indexOf("/promo") > -1)       return "See what's on";
  if (u.indexOf("giftcard") > -1 || u.indexOf("gift-card") > -1 || u.indexOf("/cards") > -1)
                                                                   return "Get a gift card";
  if (u.indexOf("loyalty") > -1 || u.indexOf("punchcard") > -1)   return "See your punch card";
  if (u.indexOf("waiver") > -1)                                   return "Sign the waiver";
  if (u.indexOf("/pass") > -1)                                    return "See passes";
  if (u.indexOf("/book") > -1)                                    return "Book your visit";
  return "Visit our website";
}

// Build the campaign HTML for a Broadcast.
//
// Two Resend merge tags do the personalising that we used to do ourselves by
// generating a separate email per subscriber:
//   {{{contact.first_name|there}}}  -> first name, or "there" if we don't have one
//   {{{RESEND_UNSUBSCRIBE_URL}}}    -> that contact's own unsubscribe link
//
// The unsubscribe tag also makes Resend attach the List-Unsubscribe and
// List-Unsubscribe-Post headers Gmail and Yahoo require for bulk mail, so we no
// longer set those by hand.
export function buildCampaignHtml(campaign) {
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const imgTag = campaign.imageMime
    ? `<img src="${SITE}/api/newsletter-image?id=${encodeURIComponent(campaign.id)}" alt="" style="width:100%;max-width:600px;display:block;border-radius:12px;margin:0 0 18px">`
    : "";
  const bookBtn = campaign.bookLink
    ? `<div style="text-align:center;margin:22px 0 6px">
         <a href="${esc(campaign.bookLink)}" style="display:inline-block;background:#c97d76;color:#fff;text-decoration:none;font-weight:800;font-size:15px;padding:14px 30px;border-radius:40px">${esc((campaign.bookLabel || "").trim() || defaultButtonLabel(campaign.bookLink))} →</a>
       </div>`
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#faf7f3;padding:22px 0">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #efe4d5">
      <div style="padding:24px 26px 8px">
        <p style="margin:0 0 14px;font-size:16px;color:#5c6470">Hi {{{contact.first_name|there}}},</p>
        ${imgTag}
        ${messageToHtml(campaign.message)}
        ${bookBtn}
      </div>
      <div style="padding:0 26px">${SIGNATURE_HTML}</div>
      <div style="padding:16px 26px 24px;color:#9a8d80;font-size:12px;line-height:1.6;text-align:center">
        You're receiving this because you've visited ${esc(studio)} or signed up for updates.
        We only email occasionally &mdash; never spam.<br>
        <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#a85f59;font-weight:700">Unsubscribe instantly</a> &middot; you'll be removed right away.
      </div>
    </div>
  </div>`;
}

// Fetch active subscribers (paginated).
export async function listActiveSubscribers(store) {
  const keys = await listAllKeys(store, { prefix: "sub:" });
  // Belt and braces: skip anyone suppressed even if their subscriber record
  // somehow says active, and de-duplicate on the normalised address so nobody
  // can receive the same campaign twice.
  const suppKeys = new Set((await listAllKeys(store, { prefix: "supp:" }).catch(() => []))
    .map(k => k.slice("supp:".length)));
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    let s = null; try { s = await store.get(k, { type: "json", consistency: "strong" }); } catch {}
    if (!s || !s.email || s.active === false) continue;
    const e = cleanEmail(s.email);
    if (!e || suppKeys.has(e) || seen.has(e)) continue;
    seen.add(e);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contact sync
// ---------------------------------------------------------------------------

function csvCell(v) {
  return `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
}

// Split a single stored "name" into the first/last fields Resend expects, so
// {{{contact.first_name}}} renders something sensible.
function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  return { first: parts[0].slice(0, 60), last: parts.slice(1).join(" ").slice(0, 60) };
}

// Build the upload for Resend from EVERY subscriber record we hold — not just
// the active ones. Opted-out people are included with unsubscribed=true so the
// upsert can never quietly re-subscribe someone Resend already had.
export async function buildSubscriberCsv(store) {
  const keys = await listAllKeys(store, { prefix: "sub:" });
  const suppKeys = new Set((await listAllKeys(store, { prefix: "supp:" }).catch(() => []))
    .map(k => k.slice("supp:".length)));

  const rows = [["email", "first_name", "last_name", "unsubscribed"].join(",")];
  const seen = new Set();
  let active = 0, optedOut = 0;

  for (const k of keys) {
    let s = null; try { s = await store.get(k, { type: "json", consistency: "strong" }); } catch {}
    if (!s || !s.email) continue;
    const e = cleanEmail(s.email);
    if (!e || !validEmail(e) || seen.has(e)) continue;
    seen.add(e);

    const off = (s.active === false) || suppKeys.has(e);
    if (off) optedOut++; else active++;

    const n = splitName(s.name);
    rows.push([csvCell(e), csvCell(n.first), csvCell(n.last), csvCell(off ? "true" : "false")].join(","));
  }

  return { csv: rows.join("\n"), active, optedOut, total: active + optedOut };
}

// Pull unsubscribes that happened on Resend's side (their hosted unsubscribe
// page, a List-Unsubscribe click handled by Gmail, or a spam complaint) back
// into our own records. Without this, someone could opt out of a broadcast and
// still show as active in the studio's subscriber list.
export async function pullResendUnsubscribes(store, segmentId) {
  const r = await listSegmentContacts(segmentId);
  if (!r.ok) return { ok: false, error: r.error, pulled: 0 };

  let pulled = 0;
  for (const c of r.contacts) {
    if (!c || !c.unsubscribed) continue;
    const e = cleanEmail(c.email);
    if (!e) continue;

    let rec = null;
    try { rec = await store.get(subKey(e), { type: "json", consistency: "strong" }); } catch {}
    if (!rec || rec.active === false) {
      // Already off our active list — still make sure the permanent block exists.
      if (rec) await suppress(store, e, "unsubscribed-at-resend");
      continue;
    }
    rec.active = false;
    rec.unsubscribedAt = rec.unsubscribedAt || new Date().toISOString();
    rec.unsubscribeSource = "resend";
    try { await store.setJSON(subKey(e), rec); } catch {}
    await suppress(store, e, "unsubscribed-at-resend");
    pulled++;
  }
  return { ok: true, pulled };
}

// ---------------------------------------------------------------------------
// Campaign state machine
// ---------------------------------------------------------------------------
//
//   scheduled -> syncing -> ready -> queued -> sent
//                                 \-> failed (parked, owner alerted)
//
// advanceCampaign() moves a campaign AT MOST one step per call and mutates the
// record in place; the caller persists it. Every step is safe to repeat, which
// is what makes a 15-minute cron a valid driver: if a function dies halfway,
// the next run picks up from whatever was last written.
//
// Double-send protection lives in two saved fields:
//   campaign.broadcastId     - set the moment a draft exists, so a retry never
//                              creates a SECOND broadcast to the same list
//   campaign.sendRequestedAt - set the moment send is requested, so a retry
//                              only ever polls status instead of re-sending

function noteError(campaign, message) {
  campaign.lastError = message;
  campaign.lastErrorAt = new Date().toISOString();
  campaign.errorCount = (campaign.errorCount || 0) + 1;
  // Stop hammering a broken campaign. After several failures it parks itself so
  // a human looks at it instead of retrying all night.
  if (campaign.errorCount >= 4) campaign.status = "failed";
}
function clearError(campaign) {
  campaign.lastError = "";
  campaign.errorCount = 0;
}

export async function advanceCampaign(store, campaign) {
  if (!marketingConfigured()) {
    return { changed: false, done: false, error: "email-not-configured" };
  }
  campaign.stats = campaign.stats || { sent: 0, failed: 0, total: 0 };

  // --- scheduled: has its time arrived? ------------------------------------
  if (campaign.status === "scheduled") {
    if (!campaign.scheduledAt || Date.parse(campaign.scheduledAt) > Date.now()) {
      return { changed: false, done: false, waiting: true };
    }
    campaign.status = "syncing";
    return { changed: true, done: false, stage: "syncing" };
  }

  if (campaign.status === "sent" || campaign.status === "failed") {
    return { changed: false, done: campaign.status === "sent" };
  }

  // Every remaining stage needs the segment id.
  if (!campaign.segmentId) {
    const seg = await resolveSegmentId();
    if (!seg.ok) { noteError(campaign, seg.error === "email-not-configured" ? "Resend isn't configured." : seg.error); return { changed: true, done: false, error: campaign.lastError }; }
    campaign.segmentId = seg.id;
  }

  // --- syncing: get the subscriber list into Resend ------------------------
  if (campaign.status === "syncing") {
    if (!campaign.importId) {
      // Pull Resend-side unsubscribes down FIRST, so the CSV we're about to
      // upload already reflects them and can't undo an opt-out.
      const pull = await pullResendUnsubscribes(store, campaign.segmentId);
      if (pull.ok && pull.pulled) campaign.pulledUnsubs = (campaign.pulledUnsubs || 0) + pull.pulled;

      const built = await buildSubscriberCsv(store);
      campaign.stats.total = built.active;

      if (!built.active) {
        campaign.status = "failed";
        campaign.lastError = "There are no active subscribers to send to.";
        campaign.lastErrorAt = new Date().toISOString();
        return { changed: true, done: false, error: campaign.lastError };
      }
      const cap = CONTACT_CAP();
      if (built.total > cap) {
        campaign.status = "failed";
        campaign.lastError = `Your list holds ${built.total} contacts but the Resend marketing plan allows ${cap}. Nothing was sent. Remove some contacts or raise the plan first.`;
        campaign.lastErrorAt = new Date().toISOString();
        return { changed: true, done: false, error: campaign.lastError };
      }

      const imp = await importContactsCsv(built.csv, campaign.segmentId);
      if (!imp.ok) { noteError(campaign, imp.error); return { changed: true, done: false, error: campaign.lastError }; }
      campaign.importId = imp.id;
      campaign.importStartedAt = new Date().toISOString();
      clearError(campaign);
      return { changed: true, done: false, stage: "importing" };
    }

    const st = await getImport(campaign.importId);
    if (!st.ok) { noteError(campaign, st.error); return { changed: true, done: false, error: campaign.lastError }; }

    const s = String(st.status || "").toLowerCase();
    if (s === "completed" || s === "complete" || s === "finished") {
      campaign.importCounts = st.counts || null;
      campaign.status = "ready";
      clearError(campaign);
      return { changed: true, done: false, stage: "ready" };
    }
    if (s === "failed" || s === "canceled" || s === "cancelled") {
      campaign.status = "failed";
      campaign.lastError = "Resend couldn't process the subscriber upload. Nothing was sent.";
      campaign.lastErrorAt = new Date().toISOString();
      return { changed: true, done: false, error: campaign.lastError };
    }
    // Still working. Park it if it's been stuck rather than slow.
    if (campaign.importStartedAt && (Date.now() - Date.parse(campaign.importStartedAt)) > IMPORT_TIMEOUT_MS) {
      campaign.status = "failed";
      campaign.lastError = "The subscriber upload to Resend never finished. Nothing was sent.";
      campaign.lastErrorAt = new Date().toISOString();
      return { changed: true, done: false, error: campaign.lastError };
    }
    return { changed: false, done: false, stage: "importing" };
  }

  // --- ready: create the broadcast, then send it ---------------------------
  if (campaign.status === "ready") {
    const from = process.env.NEWSLETTER_FROM || process.env.EMAIL_FROM || "onboarding@resend.dev";
    const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
    const replyTo = process.env.STUDIO_EMAIL || "hello@littlehavenplay.com";

    if (!campaign.broadcastId) {
      const draft = await createBroadcastDraft({
        segmentId: campaign.segmentId,
        from: fromHeader(from, studio),
        replyTo,
        subject: campaign.subject,
        html: buildCampaignHtml(campaign),
        name: campaign.subject,
      });
      if (!draft.ok) { noteError(campaign, draft.error); return { changed: true, done: false, error: campaign.lastError }; }
      // Persist the id BEFORE sending. If this function dies now, the retry
      // finds the draft and sends it once — it never builds a second one.
      campaign.broadcastId = draft.id;
      clearError(campaign);
      return { changed: true, done: false, stage: "drafted" };
    }

    if (!campaign.sendRequestedAt) {
      const snt = await sendBroadcast(campaign.broadcastId, null);
      if (!snt.ok) { noteError(campaign, snt.error); return { changed: true, done: false, error: campaign.lastError }; }
      campaign.sendRequestedAt = new Date().toISOString();
    }
    campaign.status = "queued";
    clearError(campaign);
    return { changed: true, done: false, stage: "queued" };
  }

  // --- queued: wait for Resend to report it out ----------------------------
  if (campaign.status === "queued") {
    if (!campaign.broadcastId) {           // shouldn't happen; recover rather than stall
      campaign.status = "ready";
      return { changed: true, done: false, stage: "ready" };
    }
    const b = await getBroadcast(campaign.broadcastId);
    if (!b.ok) { noteError(campaign, b.error); return { changed: true, done: false, error: campaign.lastError }; }

    const status = (b.data && b.data.status) || "";
    if (broadcastIsDone(status)) {
      campaign.status = "sent";
      campaign.sentAt = campaign.sentAt || new Date().toISOString();
      campaign.stats.sent = campaign.stats.total || campaign.stats.sent || 0;
      clearError(campaign);
      return { changed: true, done: true, stage: "sent" };
    }
    if (broadcastFailed(status)) {
      campaign.status = "failed";
      campaign.lastError = `Resend reported the broadcast as "${status}".`;
      campaign.lastErrorAt = new Date().toISOString();
      return { changed: true, done: false, error: campaign.lastError };
    }
    return { changed: false, done: false, stage: "queued" };
  }

  return { changed: false, done: false };
}

// Convenience for callers that want to push a campaign along several steps in
// one request (the "Send now" button) rather than one stage per cron tick.
//
// budgetMs buys a short wait when the only thing blocking us is Resend still
// chewing on the contact import. For a list of a few hundred that finishes in
// seconds, so "Send now" genuinely sends now instead of reporting "in about 15
// minutes". If the budget runs out the cron takes over — no work is lost.
export async function runCampaign(store, campaign, { maxSteps = 10, budgetMs = 0, key: blobKey } = {}) {
  const k = blobKey || ("campaign:" + campaign.id);
  const deadline = Date.now() + Math.max(0, budgetMs);
  let steps = 0, last = null;

  for (let i = 0; i < maxSteps; i++) {
    last = await advanceCampaign(store, campaign);
    if (last.changed) { steps++; try { await store.setJSON(k, campaign); } catch {} }

    if (last.error === "email-not-configured") break;
    if (last.done || last.waiting) break;
    if (campaign.status === "failed") break;
    if (last.changed) continue;

    // Nothing moved. Only worth waiting on an import that's still running.
    if (last.stage === "importing" && Date.now() + 1200 < deadline) {
      await new Promise(r => setTimeout(r, 1200));
      continue;
    }
    break;   // otherwise hand off to the cron
  }
  return { steps, last };
}
