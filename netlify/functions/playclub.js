// Play Club — monthly membership plans.
//
// Each plan is just a Square subscription Payment Link. Square handles the
// charging, renewals, cancellations and receipts; this only stores what to show
// on the page and where the Subscribe button points. That keeps recurring
// billing entirely inside Square, where it belongs.
//
// Public (no key):
//   { action:"public" }                  -> banner + visible plans, for the page
// Admin (ADMIN_KEY or STAFF_PIN):
//   { key, action:"list" }
//   { key, action:"save", plan:{...} }   -> add or update one plan
//   { key, action:"delete", id }
//   { key, action:"reorder", ids:[...] }
//   { key, action:"banner", dataUrl|null, heading, blurb }
//
// Images are stored as base64 in the same "site" store the partner logos use and
// served back by /api/playclub-image, so the page stays fast and nothing depends
// on an external host.
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";

const STORE = "site";
const PLANS = "playclub:plans";
const META = "playclub:meta";
const MEMBERS = "playclub:members";

// Short, unambiguous, easy to read aloud at the desk. No 0/O or 1/I/L.
const MEMCHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newMemberCode() {
  let s = "";
  const bytes = new Uint8Array(4);
  (globalThis.crypto || require("node:crypto").webcrypto).getRandomValues(bytes);
  for (let i = 0; i < 4; i++) s += MEMCHARS[bytes[i] % MEMCHARS.length];
  return "PC" + s;
}
function last4(phone) {
  const d = (phone || "").toString().replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : "";
}
async function readMembers(store) {
  try { return (await store.get(MEMBERS, { type: "json" })) || []; } catch { return []; }
}

function todayPacific() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))
    .toISOString().slice(0, 10);
}

// Renewal falls on the same day each month. Clamp to the last day when the month
// is short, so a 31st signup renews 28 Feb rather than silently rolling into March.
export function nextRenewal(startDate, from) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "")) return null;
  const day = Number(startDate.slice(8, 10));
  const ref = from || todayPacific();
  let y = Number(ref.slice(0, 4)), m = Number(ref.slice(5, 7));
  const lastOf = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const mk = (yy, mm) => `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(day, lastOf(yy, mm))).padStart(2, "0")}`;
  let candidate = mk(y, m);
  if (candidate <= ref) { m += 1; if (m > 12) { m = 1; y += 1; } candidate = mk(y, m); }
  return candidate;
}

// Effective status right now. A cancelled membership keeps working until the paid
// period ends — prepaid, no refunds, exactly as the policy says.
export function effectiveStatus(m, today) {
  const t = today || todayPacific();
  if (!m || m.active === false) return "inactive";
  if (m.pausedUntil && m.pausedUntil > t) return "paused";
  if (m.status === "paused" && !m.pausedUntil) return "paused";
  if (m.endsOn) return m.endsOn >= t ? "cancelling" : "ended";
  return "active";
}

// Months completed, for the 18-month age-up watch.
function monthsOld(dob, on) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || "")) return null;
  const t = on || todayPacific();
  let months = (Number(t.slice(0, 4)) - Number(dob.slice(0, 4))) * 12
             + (Number(t.slice(5, 7)) - Number(dob.slice(5, 7)));
  if (Number(t.slice(8, 10)) < Number(dob.slice(8, 10))) months -= 1;
  return months;
}

// The date a child turns 18 months — when Baby/Infant pricing stops applying.
export function turns18mo(dob) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || "")) return null;
  let y = Number(dob.slice(0, 4)), m = Number(dob.slice(5, 7)) + 18, d = Number(dob.slice(8, 10));
  while (m > 12) { m -= 12; y += 1; }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

// Pull DOBs off the loyalty cards rather than asking for them twice.
async function dobsForChildren(children) {
  const out = {};
  try {
    const loyalty = getStore("loyalty");
    for (const k of await listAllKeys(loyalty, { prefix: "card:" })) {
      let c = null; try { c = await loyalty.get(k, { type: "json" }); } catch { continue; }
      if (!c || !c.code || !c.dob) continue;
      if ((children || []).some(x => (x.code || "").toUpperCase() === (c.code || "").toUpperCase())) {
        out[c.code.toUpperCase()] = c.dob;
      }
    }
  } catch {}
  return out;
}
const MAX_IMG_BYTES = 900_000;   // ~900KB of base64 — plenty for an icon

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function newId() {
  return "pc" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function readPlans(store) {
  try { return (await store.get(PLANS, { type: "json" })) || []; } catch { return []; }
}
async function readMeta(store) {
  try {
    return (await store.get(META, { type: "json" })) || {
      heading: "Monthly Play Club", blurb: "", bannerMime: null, updatedAt: null,
    };
  } catch { return { heading: "Monthly Play Club", blurb: "", bannerMime: null }; }
}

// Only accept a real Square link. A mistyped or foreign URL here would send a
// customer somewhere unexpected with their card out.
function cleanSquareLink(url) {
  const u = (url || "").toString().trim();
  if (!u) return "";
  if (!/^https:\/\//i.test(u)) return "";
  if (!/(^|\.)square\.link$|(^|\.)squareup\.com$|(^|\.)square\.site$/i.test(new URL(u).hostname)) return "";
  return u.slice(0, 400);
}


// ---------------------------------------------------------------------------
// Member emails
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function sendMemberEmail(to, subject, inner) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const bcc = process.env.STUDIO_EMAIL || "";
  if (!key || !to) return false;
  const html = `<div style="font-family:Nunito,Arial,sans-serif;max-width:560px;margin:0 auto;color:#2a2622;line-height:1.6">${inner}
    <p style="color:#8a8276;font-size:13px;margin-top:20px">${esc(studio)} &middot; hello@littlehavenplay.com</p></div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: from.indexOf("<") > -1 ? from : `${studio} <${from}>`,
        to: [to], bcc: bcc ? [bcc] : undefined, subject, html,
      }),
    });
    return res.ok;
  } catch { return false; }
}

// Welcome: what they bought, how to use it, and the terms — in that order,
// because the "how do I book" question is the one that generates the emails.
export async function sendWelcomeEmail(m, plan) {
  const site = (process.env.SITE_URL || "https://littlehavenplay.com").replace(/\/$/, "");
  const kids = (m.children || []).map(c => esc(c.name || c.code)).join(", ");
  const renewal = m.startDate ? nextRenewal(m.startDate) : null;
  const inner = `
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 6px">Welcome to the Play Club! 🎟️</h2>
    <p style="color:#5c6470">Hi ${esc((m.name || "").split(" ")[0] || "there")} — we're so happy to have you and your
    little ones in the club. Your membership is active and ready to use straight away.</p>
    ${plan && plan.imageMime ? `<p style="text-align:center;margin:16px 0">
      <img src="${site}/api/playclub-image?id=${encodeURIComponent(plan.id)}" alt="${esc(m.planName || plan.name || "Play Club")}"
           width="340" style="width:340px;max-width:100%;height:auto;border-radius:16px;display:block;margin:0 auto">
    </p>` : ""}

    <table style="width:100%;border-collapse:collapse;font-size:15px;margin:14px 0">
      <tr><td style="padding:5px 0;color:#5c6470;width:130px">Plan</td><td style="padding:5px 0;font-weight:bold">${esc(m.planName || (plan && plan.name) || "Play Club")}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Covers</td><td style="padding:5px 0;font-weight:bold">${kids || "your children"}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Membership no.</td><td style="padding:5px 0;font-weight:bold;font-family:monospace">${esc(m.code)}</td></tr>
      ${m.startDate ? `<tr><td style="padding:5px 0;color:#5c6470">Started</td><td style="padding:5px 0">${esc(m.startDate)}</td></tr>` : ""}
      ${renewal ? `<tr><td style="padding:5px 0;color:#5c6470">Next renewal</td><td style="padding:5px 0">${esc(renewal)}</td></tr>` : ""}
    </table>

    <div style="background:#e7f0df;border:1px solid #c2d7bd;border-radius:12px;padding:16px;margin:16px 0">
      <p style="margin:0 0 8px;font-weight:bold;color:#3f5d33">How to book</p>
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        <tr><td style="vertical-align:top;padding:4px 10px 4px 0;width:22px"><b style="color:#3f5d33">1</b></td>
          <td style="padding:4px 0">Go to <a href="${site}/book" style="color:#a85f59">${esc(site.replace(/^https?:\/\//, ""))}/book</a> and pick your date and time.</td></tr>
        <tr><td style="vertical-align:top;padding:4px 10px 4px 0"><b style="color:#3f5d33">2</b></td>
          <td style="padding:4px 0">In the <b>Play Club member</b> box at the top, enter the phone number you book with — or your membership number above.</td></tr>
        <tr><td style="vertical-align:top;padding:4px 10px 4px 0"><b style="color:#3f5d33">3</b></td>
          <td style="padding:4px 0">Tick which children are coming.</td></tr>
        <tr><td style="vertical-align:top;padding:4px 10px 4px 0"><b style="color:#3f5d33">4</b></td>
          <td style="padding:4px 0">Your total shows <b>$0</b>. Complete the booking as normal — there's nothing to pay.</td></tr>
      </table>
      <p style="margin:10px 0 0;font-size:14px;color:#5c6470">Please still book ahead. Membership covers admission, not a reserved place, and sessions do fill.</p>
    </div>

    <p style="font-weight:bold;margin:18px 0 6px">Membership terms</p>
    <ul style="color:#5c6470;font-size:14px;padding-left:20px;margin:0">
      <li>Billed monthly through Square on the same date each month, renewing automatically until cancelled. Where that date doesn't exist in a shorter month, billing falls on the last day.</li>
      <li>Memberships are prepaid. Cancelling stops future billing; access continues to the end of the period already paid for. Part-months are not refunded.</li>
      <li>To cancel, pause or update your card, use the <b>Manage Subscription</b> link in any Square receipt, or email us and we'll take care of it.</li>
      <li>Membership covers open play admission for the named children only, and does not include private parties, events or ticketed sessions.</li>
      <li>Membership visits are recorded in your child's visit history but do not earn loyalty punches, as admission is already covered.</li>
      <li>Baby/Infant plans apply to children aged 6–17 months. When a child turns 18 months the Toddler rate applies from the next renewal; we'll contact you a month beforehand.</li>
      <li>Studio rules apply as usual — grip socks, a signed waiver, and a supervising adult 18+.</li>
    </ul>

    <p style="color:#5c6470;margin-top:16px">Any questions, just reply to this email. We're glad to have you with us!</p>`;
  return sendMemberEmail(m.email, `Welcome to the Play Club — ${m.code}`, inner);
}

// Cancellation: no ambiguity about the last day.
async function sendCancelEmail(m, endsOn) {
  const kids = (m.children || []).map(c => esc(c.name || c.code)).join(", ");
  const inner = `
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 6px">Your Play Club membership has been cancelled</h2>
    <p style="color:#5c6470">Hi ${esc((m.name || "").split(" ")[0] || "there")}, we've cancelled your membership as requested. No further payments will be taken.</p>
    <div style="background:#fdf1ec;border:1px solid #efcfc4;border-radius:12px;padding:14px 16px;margin:14px 0">
      <p style="margin:0;font-weight:bold;color:#a85f59">You can still play until ${esc(endsOn)}</p>
      <p style="margin:6px 0 0;color:#5c6470;font-size:14px">Your membership is prepaid, so ${kids || "your children"} keep unlimited access
      for the rest of the period you've already paid for. After that date, normal admission rates apply.</p>
    </div>
    <p style="color:#5c6470;font-size:14px">As set out when you joined, prepaid periods aren't refunded in part. Everything else stays
    as it is — your children's loyalty cards, visit history and any credit are unaffected.</p>
    <p style="color:#5c6470">You're welcome back at any time; just rejoin from
    <a href="${(process.env.SITE_URL || "https://littlehavenplay.com").replace(/\/$/, "")}/playclub" style="color:#a85f59">our Play Club page</a>.</p>
    <p style="color:#5c6470">Thank you for playing with us.</p>`;
  return sendMemberEmail(m.email, `Play Club membership cancelled — access until ${endsOn}`, inner);
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = (b.action || "").toString();
  const store = getStore(STORE);

  // ---------- PUBLIC ----------
  if (action === "public") {
    const plans = (await readPlans(store)).filter(p => p && p.active !== false && p.link);
    const meta = await readMeta(store);
    return json({
      ok: true,
      heading: meta.heading || "Monthly Play Club",
      blurb: meta.blurb || "",
      hasBanner: !!meta.bannerMime,
      // Categories keep Weekday and Any Day apart on the page instead of one
      // undifferentiated wall of cards.
      categories: [...new Set(plans.map(p => (p.category || "").trim()).filter(Boolean))],
      plans: plans.map(p => ({
        id: p.id, name: p.name, blurb: p.blurb || "",
        price: p.price || "", period: p.period || "month",
        category: (p.category || "").trim(),
        link: p.link, hasImage: !!p.imageMime, badge: p.badge || "",
      })),
    });
  }

  // Booking page: "is this family a Play Club member?" Matched on the membership
  // code OR the phone they book with, so nobody has to remember anything.
  if (action === "member-check") {
    const code = (b.code || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const p4 = last4(b.phone);
    if (!code && !p4) return json({ member: false });
    const members = await readMembers(store);
    const m = members.find(x => x && x.active !== false &&
      ((code && x.code === code) || (!code && p4 && x.phone4 === p4)));
    if (!m) return json({ member: false });
    // Paused and ended memberships don't cover admission. Cancelled ones still
    // do until the paid period runs out.
    const st = effectiveStatus(m);
    if (st === "paused")  return json({ member: false, reason: "paused", resumesOn: m.pausedUntil || null });
    if (st === "ended")   return json({ member: false, reason: "ended", endedOn: m.endsOn || null });
    if (st === "inactive") return json({ member: false, reason: "inactive" });
    const plans = await readPlans(store);
    const plan = plans.find(p => p.id === m.planId);
    return json({
      member: true, code: m.code, name: m.name || "",
      planName: (plan && plan.name) || m.planName || "Play Club",
      maxChildren: m.maxChildren || (m.children || []).length || 1,
      children: (m.children || []).map(c => ({ code: c.code || "", name: c.name || "" })),
    });
  }

  // ---------- ADMIN ----------
  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Keys aren't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  if (action === "list") {
    return json({ ok: true, plans: await readPlans(store), meta: await readMeta(store) });
  }

  if (action === "save") {
    const p = b.plan || {};
    const name = (p.name || "").toString().slice(0, 80).trim();
    if (!name) return json({ error: "Give the plan a name." }, 400);
    const link = cleanSquareLink(p.link);
    if (!link) return json({ error: "Paste the Square subscription link (it should start with https://square.link/)." }, 400);

    const plans = await readPlans(store);
    const id = (p.id || "").toString() || newId();
    const existing = plans.find(x => x.id === id);

    const rec = {
      id, name, link,
      blurb: (p.blurb || "").toString().slice(0, 240),
      category: (p.category || "").toString().slice(0, 40).trim(),
      // "128" typed on its own should still read as a price on the page.
      price: (() => {
        const raw = (p.price || "").toString().slice(0, 24).trim();
        return /^[\d.,]+$/.test(raw) ? "$" + raw : raw;
      })(),
      period: (p.period || "month").toString().slice(0, 16),
      badge: (p.badge || "").toString().slice(0, 24),
      active: p.active === false ? false : true,
      imageMime: existing ? existing.imageMime || null : null,
      updatedAt: new Date().toISOString(),
    };

    // Icon, if one came with this save.
    if (typeof p.dataUrl === "string" && p.dataUrl) {
      const m = p.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!m) return json({ error: "That image didn't look like a valid file." }, 400);
      if (m[2].length > MAX_IMG_BYTES) return json({ error: "That image is too large — try one under about 600KB." }, 400);
      try { await store.set("playclub:img:" + id, m[2]); rec.imageMime = m[1]; }
      catch { return json({ error: "Couldn't save the image. Try again." }, 502); }
    } else if (p.dataUrl === null) {
      try { await store.delete("playclub:img:" + id); } catch {}
      rec.imageMime = null;
    }

    const next = existing ? plans.map(x => (x.id === id ? rec : x)) : plans.concat([rec]);
    try { await store.setJSON(PLANS, next); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, plan: rec, plans: next, message: existing ? "Plan updated." : "Plan added." });
  }

  if (action === "delete") {
    const id = (b.id || "").toString();
    const plans = await readPlans(store);
    const next = plans.filter(x => x.id !== id);
    if (next.length === plans.length) return json({ error: "That plan wasn't found." }, 404);
    try { await store.setJSON(PLANS, next); await store.delete("playclub:img:" + id); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, plans: next, message: "Plan removed. Anyone already subscribed in Square is unaffected." });
  }

  if (action === "reorder") {
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    const plans = await readPlans(store);
    const byId = new Map(plans.map(p => [p.id, p]));
    const next = ids.map(i => byId.get(i)).filter(Boolean)
      .concat(plans.filter(p => ids.indexOf(p.id) === -1));
    try { await store.setJSON(PLANS, next); } catch { return json({ error: "Couldn't save." }, 502); }
    return json({ ok: true, plans: next, message: "Order saved." });
  }

  if (action === "members") {
    return json({ ok: true, members: await readMembers(store), plans: await readPlans(store) });
  }

  if (action === "member-save") {
    const m = b.member || {};
    const name = (m.name || "").toString().slice(0, 80).trim();
    const p4 = last4(m.phone || m.phone4);
    if (!name) return json({ error: "Enter the parent's name." }, 400);
    if (!p4) return json({ error: "Enter the phone number they book with." }, 400);

    const kids = (Array.isArray(m.children) ? m.children : [])
      .map(c => ({ code: (c.code || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, ""),
                   name: (c.name || "").toString().slice(0, 80) }))
      .filter(c => c.code || c.name);
    if (!kids.length) return json({ error: "Link at least one child to this membership." }, 400);

    const members = await readMembers(store);
    const code = (m.code || "").toString().toUpperCase() || newMemberCode();
    const existing = members.find(x => x.code === code);

    // One membership per phone — two would make the booking page ambiguous.
    const clash = members.find(x => x.phone4 === p4 && x.code !== code && x.active !== false);
    if (clash) return json({ error: `That phone already has membership ${clash.code}. Edit that one instead.` }, 409);

    const rec = {
      code, name, phone4: p4,
      email: (m.email || "").toString().slice(0, 160).trim(),
      planId: (m.planId || "").toString(),
      planName: (m.planName || "").toString().slice(0, 80),
      children: kids,
      maxChildren: Math.max(1, Math.min(10, parseInt(m.maxChildren, 10) || kids.length)),
      active: m.active === false ? false : true,
      note: (m.note || "").toString().slice(0, 200),
      startedAt: existing ? existing.startedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      visits: existing ? existing.visits || 0 : 0,
    };
    rec.startDate = (m.startDate && /^\d{4}-\d{2}-\d{2}$/.test(m.startDate))
      ? m.startDate : (existing ? existing.startDate : todayPacific());
    const next = existing ? members.map(x => (x.code === code ? rec : x)) : members.concat([rec]);
    try { await store.setJSON(MEMBERS, next); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }

    // Welcome email on creation, or on request when editing.
    let emailed = false;
    if ((!existing || b.sendWelcome) && rec.email) {
      const plans = await readPlans(store);
      emailed = await sendWelcomeEmail(rec, plans.find(p2 => p2.id === rec.planId));
    }
    return json({ ok: true, member: rec, members: next, emailed,
      renewal: nextRenewal(rec.startDate),
      message: (existing ? `Membership ${code} updated.` : `Membership ${code} created for ${name}.`)
        + (emailed ? " Welcome email sent." : "") });
  }

  // Cancel: access runs to the end of the paid period, then stops by itself.
  if (action === "member-cancel") {
    const code = (b.code || "").toString().toUpperCase();
    const members = await readMembers(store);
    const i = members.findIndex(x => x.code === code);
    if (i < 0) return json({ error: "Membership not found." }, 404);
    const m = members[i];
    if (b.undo) {
      delete m.endsOn; delete m.cancelledAt; m.squareCancelled = false;
      try { await store.setJSON(MEMBERS, members); } catch { return json({ error: "Couldn't save." }, 502); }
      return json({ ok: true, members, message: `Cancellation reversed. ${code} is active again — make sure it's active in Square too.` });
    }
    const endsOn = (b.endsOn && /^\d{4}-\d{2}-\d{2}$/.test(b.endsOn))
      ? b.endsOn
      : (m.startDate ? nextRenewal(m.startDate) : todayPacific());
    m.endsOn = endsOn;
    m.cancelledAt = new Date().toISOString();
    m.cancelReason = (b.reason || "").toString().slice(0, 200);
    m.squareCancelled = false;   // until you tick it off
    try { await store.setJSON(MEMBERS, members); } catch { return json({ error: "Couldn't save." }, 502); }
    if (b.email !== false) { try { await sendCancelEmail(m, endsOn); } catch {} }
    return json({ ok: true, members, endsOn,
      message: `${code} ends ${endsOn}. They keep access until then. NOW CANCEL IT IN SQUARE — this tool cannot stop the billing.` });
  }

  // Confirms you've also cancelled in Square. Nothing else can know this.
  if (action === "member-square-done") {
    const code = (b.code || "").toString().toUpperCase();
    const members = await readMembers(store);
    const m = members.find(x => x.code === code);
    if (!m) return json({ error: "Membership not found." }, 404);
    m.squareCancelled = true;
    m.squareCancelledAt = new Date().toISOString();
    try { await store.setJSON(MEMBERS, members); } catch { return json({ error: "Couldn't save." }, 502); }
    return json({ ok: true, members, message: "Marked as cancelled in Square too." });
  }

  // Pause / resume. Square pauses at the end of the billing cycle, so this
  // mirrors that: they finish the month they've paid for.
  if (action === "member-pause") {
    const code = (b.code || "").toString().toUpperCase();
    const members = await readMembers(store);
    const m = members.find(x => x.code === code);
    if (!m) return json({ error: "Membership not found." }, 404);
    if (b.resume) {
      delete m.pausedUntil; m.status = "active"; m.resumedAt = new Date().toISOString();
      try { await store.setJSON(MEMBERS, members); } catch { return json({ error: "Couldn't save." }, 502); }
      return json({ ok: true, members, message: `${code} resumed. Resume it in Square as well.` });
    }
    const until = (b.until && /^\d{4}-\d{2}-\d{2}$/.test(b.until)) ? b.until : "";
    m.pausedUntil = until || "2099-12-31";     // no date = paused until you resume
    m.status = "paused";
    m.pausedAt = new Date().toISOString();
    try { await store.setJSON(MEMBERS, members); } catch { return json({ error: "Couldn't save." }, 502); }
    return json({ ok: true, members,
      message: `${code} paused${until ? " until " + until : " indefinitely"}. NOW PAUSE IT IN SQUARE so they aren't charged.` });
  }

  // Baby/Infant children approaching 18 months, with their renewal date.
  if (action === "ageup") {
    const members = await readMembers(store);
    const today = todayPacific();
    const horizon = (() => { const d = new Date(today + "T12:00:00"); d.setDate(d.getDate() + 60); return d.toISOString().slice(0, 10); })();
    const out = [];
    for (const m of members) {
      if (effectiveStatus(m, today) === "ended") continue;
      const dobs = await dobsForChildren(m.children || []);
      for (const c of (m.children || [])) {
        const dob = c.dob || dobs[(c.code || "").toUpperCase()];
        if (!dob) continue;
        const when = turns18mo(dob);
        if (!when || when > horizon) continue;
        out.push({
          code: m.code, name: m.name, phone4: m.phone4, email: m.email,
          planName: m.planName || "", child: c.name || c.code, childCode: c.code || "",
          dob, turns18: when, alreadyOver: when <= today,
          renewal: m.startDate ? nextRenewal(m.startDate, today) : null,
          noticeSent: (m.ageUpNotified || []).indexOf(c.code) > -1,
        });
      }
    }
    out.sort((a, c2) => String(a.turns18).localeCompare(String(c2.turns18)));
    return json({ ok: true, watchlist: out, today, horizon });
  }

  if (action === "member-delete") {
    const code = (b.code || "").toString().toUpperCase();
    const members = await readMembers(store);
    const next = members.filter(x => x.code !== code);
    if (next.length === members.length) return json({ error: "Membership not found." }, 404);
    try { await store.setJSON(MEMBERS, next); } catch { return json({ error: "Couldn't save." }, 502); }
    return json({ ok: true, members: next,
      message: `Membership ${code} removed. Cancel the subscription in Square separately if you haven't already.` });
  }

  if (action === "banner") {
    const meta = await readMeta(store);
    if (b.heading != null) meta.heading = (b.heading || "").toString().slice(0, 80);
    if (b.blurb != null) meta.blurb = (b.blurb || "").toString().slice(0, 300);
    if (typeof b.dataUrl === "string" && b.dataUrl) {
      const m = b.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!m) return json({ error: "That image didn't look like a valid file." }, 400);
      if (m[2].length > MAX_IMG_BYTES) return json({ error: "That banner is too large — try one under about 600KB." }, 400);
      try { await store.set("playclub:banner", m[2]); meta.bannerMime = m[1]; }
      catch { return json({ error: "Couldn't save the banner." }, 502); }
    } else if (b.dataUrl === null) {
      try { await store.delete("playclub:banner"); } catch {}
      meta.bannerMime = null;
    }
    meta.updatedAt = new Date().toISOString();
    try { await store.setJSON(META, meta); } catch { return json({ error: "Couldn't save." }, 502); }
    return json({ ok: true, meta, message: "Saved." });
  }

  return json({ error: "Unknown action." }, 400);
};

export const config = { path: "/api/playclub" };
