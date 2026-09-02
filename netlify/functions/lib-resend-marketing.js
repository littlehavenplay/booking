// Resend MARKETING API wrapper (Segments · Contacts · Broadcasts).
//
// WHY THIS FILE EXISTS
// --------------------
// Resend bills two completely separate products against two separate quotas:
//
//   Transactional  (POST /emails, POST /emails/batch)
//        Free tier: 3,000/month AND a hard 100/DAY cap. Every recipient counts
//        as one email, including each address in a batch call.
//
//   Marketing      (POST /broadcasts, sent to a Segment of Contacts)
//        Free tier: billed by CONTACTS STORED (1,000), not emails sent.
//        Sending to those contacts is unlimited.
//
// The newsletter used to loop the TRANSACTIONAL batch endpoint, so a single
// blast to ~200 subscribers burned 200 of the 100/day allowance and locked the
// whole account out — including booking confirmations. Everything in here
// exists so campaigns go out on the marketing side instead, where they're free.
//
// NOTHING in this file may ever fall back to POST /emails. A broken campaign
// must park itself and alert the owner rather than quietly re-creating the very
// problem this replaces.

const API = "https://api.resend.com";

// Resend returns 403 / error code 1010 for requests with no User-Agent, which is
// easy to hit from a serverless runtime. Always send one.
const UA = "little-haven-newsletter/1.0";

export function marketingConfigured() {
  return !!process.env.RESEND_API_KEY;
}

function key() {
  return process.env.RESEND_API_KEY || "";
}

// ---------------------------------------------------------------------------
// Low-level request helper.
//
// Never throws. Always returns { ok, status, data, error } so every caller can
// record WHY something failed instead of retrying blind. (The old batch sender
// only checked res.ok, which is how a campaign sat at 0 sent for hours with
// nothing on screen to explain it.)
// ---------------------------------------------------------------------------
async function rq(method, path, body, isForm = false) {
  const k = key();
  if (!k) return { ok: false, status: 0, data: null, error: "email-not-configured" };

  const headers = { "Authorization": `Bearer ${k}`, "User-Agent": UA };
  let payload;
  if (isForm) {
    payload = body;                       // FormData — fetch sets the boundary itself
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(API + path, { method, headers, body: payload });
  } catch (e) {
    return { ok: false, status: 0, data: null, error: "Couldn't reach Resend: " + (e && e.message ? e.message : "network error") };
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok) {
    let detail = "";
    if (data) detail = data.message || data.error || JSON.stringify(data).slice(0, 300);
    return { ok: false, status: res.status, data, error: `Resend ${method} ${path} failed (HTTP ${res.status})${detail ? ": " + detail : ""}` };
  }
  return { ok: true, status: res.status, data, error: "" };
}

// ---------------------------------------------------------------------------
// Segments (what Resend used to call Audiences).
//
// A Broadcast must target a segment id. Rather than making the studio hunt for
// a UUID in the Resend dashboard, resolve it by name and create it if missing.
// RESEND_SEGMENT_ID short-circuits this if it's ever set explicitly.
// ---------------------------------------------------------------------------
export const SEGMENT_NAME = () => process.env.RESEND_SEGMENT_NAME || "Newsletter";

export async function resolveSegmentId() {
  const pinned = (process.env.RESEND_SEGMENT_ID || "").trim();
  if (pinned) return { ok: true, id: pinned, created: false };

  const wanted = SEGMENT_NAME().trim().toLowerCase();

  const list = await rq("GET", "/segments");
  if (list.ok) {
    const rows = (list.data && Array.isArray(list.data.data)) ? list.data.data : [];
    const hit = rows.find(s => String(s.name || "").trim().toLowerCase() === wanted);
    if (hit && hit.id) return { ok: true, id: hit.id, created: false };
  } else if (list.error === "email-not-configured") {
    return { ok: false, error: "email-not-configured" };
  }

  // Not found — make it. On the free plan there's a 3-segment ceiling, so a
  // failure here is worth reporting verbatim rather than swallowing.
  const made = await rq("POST", "/segments", { name: SEGMENT_NAME() });
  if (made.ok && made.data && made.data.id) return { ok: true, id: made.data.id, created: true };
  return { ok: false, error: made.error || (list.error || "Couldn't resolve a Resend segment.") };
}

// ---------------------------------------------------------------------------
// Contacts — bulk CSV import.
//
// One request uploads the entire list. The alternative (POST /contacts per
// subscriber) would be hundreds of calls against a 10 req/sec limit inside a
// function that gets ~10 seconds to live, so it isn't viable.
//
// on_conflict:"upsert" means re-running is safe and idempotent: existing
// contacts get updated, new ones created.
// ---------------------------------------------------------------------------
export async function importContactsCsv(csv, segmentId) {
  const k = key();
  if (!k) return { ok: false, error: "email-not-configured" };

  let fd;
  try {
    fd = new FormData();
    fd.append("file", new Blob([csv], { type: "text/csv" }), "subscribers.csv");
    fd.append("column_map", JSON.stringify({
      email: "email", first_name: "first_name", last_name: "last_name", unsubscribed: "unsubscribed",
    }));
    fd.append("on_conflict", "upsert");
    if (segmentId) fd.append("segments", JSON.stringify([{ id: segmentId }]));
  } catch (e) {
    return { ok: false, error: "Couldn't build the contact upload: " + (e && e.message ? e.message : "unknown") };
  }

  const r = await rq("POST", "/contacts/imports", fd, true);
  if (!r.ok) return { ok: false, error: r.error };
  const id = r.data && r.data.id;
  if (!id) return { ok: false, error: "Resend accepted the upload but returned no import id." };
  return { ok: true, id };
}

// Import status: "completed" when Resend has finished ingesting the CSV.
export async function getImport(importId) {
  const r = await rq("GET", "/contacts/imports/" + encodeURIComponent(importId));
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  return { ok: true, status: String(d.status || ""), counts: d.counts || null };
}

// Flip one contact's global subscription status. Used to mirror a website
// unsubscribe onto the Resend side immediately, so the next broadcast skips
// them even if a sync hasn't run yet.
export async function setContactUnsubscribed(email, unsubscribed = true) {
  const r = await rq("PATCH", "/contacts/" + encodeURIComponent(email), { unsubscribed: !!unsubscribed });
  // A 404 just means they were never uploaded — that's a success from our side.
  if (!r.ok && r.status === 404) return { ok: true, missing: true };
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// DELETE a contact from the marketing side entirely.
//
// Unsubscribing should require nothing from the studio afterwards. Flagging the
// contact as unsubscribed is enough to stop mail, but it still occupies one of
// the 1,000 free contact slots forever, which would slowly fill the plan with
// people who asked to be left alone. Their address stays on our own permanent
// suppression list, so a later import can never re-add them.
export async function deleteContact(email) {
  const r = await rq("DELETE", "/contacts/" + encodeURIComponent(email));
  if (!r.ok && r.status === 404) return { ok: true, missing: true };
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// Every contact in the segment, following pagination. Used to pull unsubscribes
// that happened on Resend's side (their hosted unsubscribe page, or a spam
// complaint) back down into our own suppression list.
export async function listSegmentContacts(segmentId) {
  const out = [];
  let after = null;
  for (let page = 0; page < 25; page++) {          // 25 × 100 = 2,500 hard ceiling
    const qs = "?limit=100" + (after ? "&after=" + encodeURIComponent(after) : "");
    const r = await rq("GET", "/segments/" + encodeURIComponent(segmentId) + "/contacts" + qs);
    if (!r.ok) return { ok: false, error: r.error, contacts: out };
    const d = r.data || {};
    const rows = Array.isArray(d.data) ? d.data : [];
    for (const c of rows) out.push(c);
    if (!d.has_more || !rows.length) break;
    after = rows[rows.length - 1].id;
    if (!after) break;
  }
  return { ok: true, contacts: out };
}

// ---------------------------------------------------------------------------
// Broadcasts.
//
// Deliberately split into create-then-send rather than the one-shot
// { send: true } form. Creating a DRAFT first lets us persist the broadcast id
// before anything is delivered, so a function that dies mid-flight resumes by
// checking that id instead of creating a second broadcast and double-mailing
// the whole list.
// ---------------------------------------------------------------------------
export async function createBroadcastDraft({ segmentId, from, replyTo, subject, html, name }) {
  const body = { segment_id: segmentId, from, subject, html };
  if (replyTo) body.reply_to = replyTo;
  if (name) body.name = String(name).slice(0, 190);

  const r = await rq("POST", "/broadcasts", body);
  if (!r.ok) return { ok: false, error: r.error };
  const id = r.data && r.data.id;
  if (!id) return { ok: false, error: "Resend created the broadcast but returned no id." };
  return { ok: true, id };
}

export async function sendBroadcast(broadcastId, scheduledAt) {
  const body = scheduledAt ? { scheduled_at: scheduledAt } : {};
  const r = await rq("POST", "/broadcasts/" + encodeURIComponent(broadcastId) + "/send", body);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function getBroadcast(broadcastId) {
  const r = await rq("GET", "/broadcasts/" + encodeURIComponent(broadcastId));
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: r.data || {} };
}

// Resend has used a few labels for a finished broadcast across API versions, so
// match generously rather than pinning one string and silently never completing.
export function broadcastIsDone(status) {
  const s = String(status || "").toLowerCase();
  return s === "sent" || s === "completed" || s === "complete" || s === "delivered" || s === "finished";
}
export function broadcastFailed(status) {
  const s = String(status || "").toLowerCase();
  return s === "failed" || s === "canceled" || s === "cancelled";
}
