// One-time email telling EXISTING Play Club members about buddy passes.
//
// Sent at most once per membership, ever: a record is written per member
// (announce:buddy-v1:<CODE>) and the send carries a stable idempotency key, so
// pressing the button twice, a retry, or two staff pressing it at once cannot
// email anyone a second time. New members don't need this -- the perk is on the
// Play Club page and in the FAQ they read when joining.

import { getStore } from "@netlify/blobs";
import { resendEmail, fromHeader, footerHtml, footerText, SITE } from "./lib-email.js";
import { activeForIssue, passPlanFor, thisMonth, monthEnd } from "./lib-buddypass.js";

const STORE = "buddypasses";
const VERSION = "buddy-v1";
const markKey = code => `announce:${VERSION}:${String(code).toUpperCase()}`;
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const firstName = n => String(n || "").trim().split(/\s+/)[0] || "";

export async function recipients() {
  let members = [];
  try { members = (await getStore("site").get("playclub:members", { type: "json" })) || []; } catch {}
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })).toISOString().slice(0, 10);
  const store = getStore(STORE);
  const out = [];
  for (const m of members) {
    if (!m || !m.code) continue;
    const email = String(m.email || "").trim();
    const active = activeForIssue(m, today);
    let sent = null; try { sent = await store.get(markKey(m.code), { type: "json" }); } catch {}
    const plan = passPlanFor(m);
    out.push({
      code: m.code, name: m.name || "", email,
      planKind: m.planKind || "anyday",
      kids: plan.map(p => p.child),
      passes: plan.length,
      eligible: active && /^\S+@\S+\.\S+$/.test(email) && !sent,
      reason: !active ? "not active" : !/^\S+@\S+\.\S+$/.test(email) ? "no email on file" : sent ? "already told" : "",
      sentAt: sent ? sent.at : null,
    });
  }
  return out;
}

export function buildEmail(r) {
  const kids = r.kids.filter(k => !/^Covered child \d+$/.test(k)).map(firstName);
  const who = kids.length >= 2 ? `${kids.slice(0, -1).join(", ")} and ${kids[kids.length - 1]}`
            : kids.length === 1 ? kids[0] : "your little one";
  const each = r.passes > 1 ? `${who} each get one` : `${who} gets one`;
  const weekday = r.planKind === "weekday";
  const until = monthEnd(thisMonth());
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:540px;margin:0 auto;color:#2a2622;line-height:1.6">
  <h2 style="font-family:Georgia,serif;font-weight:normal;color:#a85f59;margin:0 0 10px">A new perk for ${esc(who)} &#129309;</h2>
  <p>Hi ${esc(firstName(r.name))},</p>
  <p>Your Play Club membership now comes with a <b>free buddy pass every month</b> &mdash; ${esc(each)}, so they can bring a friend to play.</p>
  <ul style="padding-left:18px;margin:12px 0">
    <li>The friend <b>and the grown-up who brings them</b> play free.</li>
    <li>Add your buddy when you book online.</li>
    <li>${weekday ? "Your Weekday plan&rsquo;s buddy pass works Monday to Friday." : "Use it any day we&rsquo;re open."}</li>
    <li>Grip socks are still $3 if they need a pair, and they&rsquo;ll need a waiver.</li>
    <li>A new pass arrives on the 1st of each month.</li>
  </ul>
  <p style="margin:18px 0"><a href="${SITE}/book.html" style="background:#c97d76;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold;display:inline-block">Book a visit with a buddy</a></p>
  ${footerHtml()}
</div>`;
  const text = `A new perk for ${who}\n\nHi ${firstName(r.name)},\n\nYour Play Club membership now comes with a free buddy pass every month — ${each}, so they can bring a friend to play.\n\n`
    + `- The friend and the grown-up who brings them play free.\n`
    + `- Add your buddy when you book online.\n`
    + `- ${weekday ? "Your Weekday plan's buddy pass works Monday to Friday." : "Use it any day we're open."}\n`
    + `- Grip socks are still $3 if needed, and they'll need a waiver.\n`
    + `- A new pass arrives on the 1st of each month.\n\n`
    + `Book: ${SITE}/book.html\n\n${footerText()}`;
  return { subject: `A buddy pass for ${who} every month \u{1F91D}`, html, text };
}

export async function sendOne(r) {
  const from = process.env.EMAIL_FROM || "", studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const e = buildEmail(r);
  const ok = await resendEmail({ from: fromHeader(from, studio), to: [r.email], subject: e.subject, html: e.html, text: e.text },
                               { idempotencyKey: `${VERSION}:${String(r.code).toUpperCase()}` });
  if (ok) {
    try { await getStore(STORE).setJSON(markKey(r.code), { at: new Date().toISOString(), email: r.email }); } catch {}
  }
  return ok;
}
