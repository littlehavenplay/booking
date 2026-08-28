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
      plans: plans.map(p => ({
        id: p.id, name: p.name, blurb: p.blurb || "",
        price: p.price || "", period: p.period || "month",
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
      price: (p.price || "").toString().slice(0, 24),
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
    const next = existing ? members.map(x => (x.code === code ? rec : x)) : members.concat([rec]);
    try { await store.setJSON(MEMBERS, next); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, member: rec, members: next,
      message: existing ? `Membership ${code} updated.` : `Membership ${code} created for ${name}.` });
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
