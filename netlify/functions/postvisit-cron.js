// Scheduled: the morning after a visit, thank the family, ask for a Google
// review, and nudge them to refer a friend.
//
// Timing is deliberate — the morning after, not the same evening. Parents are
// getting kids to bed at 7pm; a 10am email the next day gets read.
//
// One email per booking, ever. `postVisitSentAt` is written onto the booking
// record itself, so a re-run (or a manual invoke) can't send a second copy.
//
// IMPORTANT on the review ask: the reward is never conditional on leaving a
// review. Google prohibits incentivised reviews and penalises listings that do
// it. The review ask and the referral offer sit in the same email but are
// deliberately separate, with no link between them.
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { SIGNATURE_HTML, fromHeader } from "./lib-email.js";
import { getOrCreateFamilyCode, shareMessage, reconcileLots, lotSummaryLines } from "./lib-referral.js";

const SITE = process.env.SITE_URL || "https://littlehavenplay.com";
const REVIEW_URL = process.env.GOOGLE_REVIEW_URL || "";

function pacificToday() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))
    .toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export default async () => {
  const yesterday = addDays(pacificToday(), -1);
  const bookings = getStore("bookings");
  const arrivals = getStore("arrivals");

  let arrivedMap = {};
  try { arrivedMap = (await arrivals.get(yesterday, { type: "json" })) || {}; } catch { arrivedMap = {}; }
  const arrivedIds = new Set(Object.keys(arrivedMap).filter(k => arrivedMap[k]));
  if (!arrivedIds.size) return new Response("no arrivals", { status: 200 });

  let sent = 0, skipped = 0, failed = 0;
  let keys = [];
  try { keys = await listAllKeys(bookings); } catch { return new Response("store error", { status: 200 }); }

  for (const key of keys) {
    if (!key.startsWith(yesterday + "__")) continue;
    let rec = null;
    try { rec = await bookings.get(key, { type: "json", consistency: "strong" }); } catch { continue; }
    if (!rec || !Array.isArray(rec.bookings)) continue;

    let touched = false;
    for (const entry of rec.bookings) {
      if (!entry || !arrivedIds.has(entry.id)) continue;
      if (entry.postVisitSentAt) { skipped++; continue; }
      if (!entry.email) { skipped++; continue; }

      const fam = await getOrCreateFamilyCode(entry.phone, { name: entry.name, email: entry.email });
      const ok = await sendFollowUp(entry, fam);
      if (ok) { entry.postVisitSentAt = new Date().toISOString(); touched = true; sent++; }
      else failed++;
    }
    if (touched) { try { await bookings.setJSON(key, rec); } catch {} }
  }
  return new Response(`post-visit: sent ${sent}, skipped ${skipped}, failed ${failed}`, { status: 200 });
};

async function sendFollowUp(entry, fam) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  if (!key || !entry.email) return false;

  const firstName = (entry.name || "").split(" ")[0] || "there";
  const share = fam ? shareMessage(fam.code, SITE) : null;

  // If they already have referral credit sitting there, remind them — an unspent
  // balance with a date on it is the strongest reason to book again.
  let balanceBlock = "";
  if (fam && fam.creditCode) {
    try {
      const rec = await getStore("credits").get("credit:" + fam.creditCode, { type: "json" });
      if (rec) {
        reconcileLots(rec);
        if ((rec.amount || 0) > 0) {
          const lines = lotSummaryLines(rec);
          balanceBlock = `
          <div style="background:#fdf1ec;border:1px solid #efcfc4;border-radius:14px;padding:14px 16px;margin:14px 0">
            <p style="margin:0 0 4px;font-weight:bold;color:#a85f59">You have $${((rec.amount || 0) / 100).toFixed(2)} in referral credit waiting</p>
            <p style="margin:0;color:#5c6470;font-size:14px">Use code <b>${esc(rec.code)}</b> in the store credit box next time you book.
            ${lines.length ? "<br>" + lines.map(esc).join("<br>") : ""}</p>
          </div>`;
        }
      }
    } catch {}
  }

  const reviewBlock = REVIEW_URL ? `
    <div style="background:#f3f0ff;border-radius:14px;padding:16px;margin:14px 0;text-align:center">
      <p style="margin:0 0 4px;font-weight:bold;color:#5b4636">Did the little ones have fun?</p>
      <p style="margin:0 0 12px;color:#5c6470;font-size:14px">A quick review helps other local families find us. It takes about 30 seconds.</p>
      <a href="${esc(REVIEW_URL)}" style="display:inline-block;background:#7a6253;color:#fff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:10px">Leave a Google review →</a>
    </div>` : "";

  const referBlock = share ? `
    <div style="background:#e7f0df;border:1px solid #c2d7bd;border-radius:14px;padding:16px;margin:14px 0">
      <p style="margin:0 0 6px;font-weight:bold;color:#3f5d33">🎈 Know a family who'd love it here?</p>
      <p style="margin:0 0 10px;color:#5c6470;font-size:14px">Share your code and they get <b>$5 off</b> their first visit.
      Once they come and play, <b>$5</b> is yours. There's no limit — refer four families and that's $20 toward your next visit,
      and it all sits on one code that keeps adding up.</p>
      <div style="background:#fff;border:2px dashed #c2d7bd;border-radius:12px;padding:12px;text-align:center;margin:0 0 10px">
        <div style="font-size:.7rem;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:#5c6470">Your referral code</div>
        <div style="font-family:monospace;font-size:1.5rem;font-weight:bold;color:#4d7848;letter-spacing:.06em">${esc(fam.code)}</div>
      </div>
      <p style="margin:0;text-align:center">
        <a href="${esc(SITE)}/refer" style="display:inline-block;background:#7ba676;color:#fff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:10px">Share it in one tap →</a>
      </p>
    </div>` : "";

  const html = `
  <div style="font-family:Nunito,Arial,sans-serif;max-width:560px;margin:0 auto;color:#2a2622">
    <h2 style="color:#a85f59;font-weight:normal">Thanks for playing with us! 💛</h2>
    <p style="color:#5c6470">Hi ${esc(firstName)} — we hope you and the little ones had a lovely time yesterday.
    Thank you for spending part of your day at ${esc(studio)}.</p>
    ${balanceBlock}
    ${reviewBlock}
    ${referBlock}
    <p style="color:#5c6470;font-size:13px;margin-top:16px">Hope to see you again soon! Book any time at
    <a href="${esc(SITE)}/book" style="color:#a85f59">${esc(SITE.replace(/^https?:\/\//, ""))}/book</a>. — ${esc(studio)}</p>
  </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromHeader(from, studio), to: [entry.email],
        subject: `Thanks for playing with us! 💛`, html: html + SIGNATURE_HTML }),
    });
    return res.ok;
  } catch { return false; }
}

// 10:00 AM Pacific (17:00 UTC) — the morning after, once people are up and about.
export const config = { schedule: "0 17 * * *" };
