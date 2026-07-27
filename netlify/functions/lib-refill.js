// Shared logic for the weekly "your punch card is used up" refill reminder campaign.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const STUDIO = "Little Haven Play Studio";
const BOOK_URL = "https://littlehavenplay.com/book.html";

export function unsubToken(email) {
  return createHash("sha256")
    .update((email || "").toLowerCase().trim() + "::" + (process.env.ADMIN_KEY || "lh-refill"))
    .digest("hex").slice(0, 16);
}

const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
function todayISO() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }
function isExpired(p) { return p.expiry && p.expiry < todayISO(); }

// Runs the campaign. Returns a summary. Pass { dryRun:true } to count without sending.
export async function runRefillCampaign({ dryRun = false } = {}) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studioEmail = process.env.STUDIO_EMAIL;
  const out = { scanned: 0, candidates: 0, sent: 0, skippedActive: 0, skippedOptout: 0, skippedRecent: 0, dryRun };

  const passes = getStore("passes");
  const site = getStore("site");

  let list; try { list = await passes.list({ prefix: "pass:" }); } catch { return out; }

  // Group every card by buyer email; track whether they still have a usable card.
  const byEmail = new Map();
  for (const bl of (list.blobs || [])) {
    let p; try { p = await passes.get(bl.key, { type: "json" }); } catch { continue; }
    if (!p || !p.buyerEmail) continue;
    out.scanned++;
    const em = p.buyerEmail.toLowerCase().trim();
    if (!byEmail.has(em)) byEmail.set(em, { name: "", active: false, usedUp: false, label: "punch card", saveCard: false });
    const e = byEmail.get(em);
    const usable = (p.active !== false) && (p.visitsRemaining || 0) > 0 && !isExpired(p);
    if (usable) e.active = true;
    if ((p.visitsRemaining || 0) === 0 && p.active !== false) { e.usedUp = true; e.label = p.label || e.label; }
    if (p.saveCard) e.saveCard = true;
    if (p.buyerName && !e.name) e.name = p.buyerName;
  }

  let optout = {}; try { optout = (await site.get("refillOptout", { type: "json" })) || {}; } catch {}
  let sentMap = {}; try { sentMap = (await site.get("refillSent", { type: "json" })) || {}; } catch {}
  const now = Date.now();

  for (const [em, e] of byEmail) {
    if (e.active) { out.skippedActive++; continue; }   // still has a usable card → they refilled / are covered
    if (!e.usedUp) continue;                            // nothing actually used up
    if (optout[em]) { out.skippedOptout++; continue; } // unsubscribed
    const last = sentMap[em] ? Date.parse(sentMap[em]) : 0;
    if (last && (now - last) < 6 * 24 * 3600 * 1000) { out.skippedRecent++; continue; } // already reminded this week
    out.candidates++;
    if (dryRun || !key) continue;
    if (await sendRefill(em, e, key, from, studioEmail)) { out.sent++; sentMap[em] = new Date().toISOString(); }
  }

  if (!dryRun) { try { await site.setJSON("refillSent", sentMap); } catch {} }
  return out;
}

async function sendRefill(email, e, key, from, studioEmail) {
  const unsub = `https://littlehavenplay.com/api/refill-unsubscribe?e=${encodeURIComponent(email)}&t=${unsubToken(email)}`;
  const html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6;max-width:560px">
    <h2 style="color:#a85f59;font-weight:normal">We miss you already! 🎈</h2>
    <p>Hi ${esc(e.name) || "there"},</p>
    <p>Looks like your prepaid <b>${esc(e.label)}</b> is all used up — we hope the little ones had a blast! That prepaid card has since been retired, so there's nothing to buy or reload.</p>
    <p>Good news: you're already on our <b>free Loyalty Punch Card</b> program — just book your next visit online like normal, and after 7 visits your 8th is on us automatically.</p>
    <p><a href="${BOOK_URL}" style="display:inline-block;background:#c97d76;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:11px">Book your next visit →</a></p>
    <p style="color:#8a8276;font-size:13px;margin-top:22px">You're receiving this because you have a punch card with us. <a href="${unsub}" style="color:#8a8276">Unsubscribe from these reminders</a>.</p>
    <p style="color:#5c6470;font-size:13px">See you soon! — ${STUDIO}</p></div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${STUDIO} <${from}>`, to: [email], bcc: studioEmail ? [studioEmail] : undefined, subject: `We miss you! Come play again — your free loyalty punch card is waiting 🎈`, html }),
    });
    return res.ok;
  } catch { return false; }
}
