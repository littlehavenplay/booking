// POST /api/guest-pass   (admin key or staff PIN)
//   { action: "status",  code }            -> this month's balance
//   { action: "redeem",  code, by }        -> spend one
//   { action: "undo",    code }            -> put the last one back
//   { action: "issue-now" }                -> run the monthly issue immediately
//
// Also runs itself on the 1st of every month to issue that month's passes.
// Issuance is idempotent per membership per month, so running it twice — by
// schedule, by hand, or both — cannot hand out a second set.

import { getStore } from "@netlify/blobs";
import { issueFor, redeem, undo, readPasses, monthKey, passesFor } from "./lib-guestpass.js";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

async function allMembers() {
  try {
    const rec = await getStore("playclub").get("playclub:members", { type: "json" });
    return Array.isArray(rec) ? rec : (rec && rec.members) || [];
  } catch { return []; }
}

// Only memberships that actually cover visits right now get passes. A paused or
// ended membership shouldn't quietly accrue them.
function isActive(m) {
  if (!m || m.active === false) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (m.status === "ended") return false;
  if (m.endsOn && m.endsOn < today) return false;
  if (m.pausedUntil && m.pausedUntil > today) return false;
  if (m.status === "paused" && !m.pausedUntil) return false;
  return true;
}

async function issueAll(mk) {
  const members = await allMembers();
  let issued = 0, skipped = 0, already = 0, passes = 0;
  for (const m of members) {
    if (!isActive(m) || !m.code) { skipped++; continue; }
    const r = await issueFor(m, mk);
    if (r.alreadyExisted) already++;
    else if (r.issued > 0) { issued++; passes += r.issued; }
    else skipped++;
  }
  return { month: mk, memberships: members.length, issued, already, skipped, passesIssued: passes };
}

export default async (req) => {
  // Scheduled invocation: no body, just issue this month's passes.
  if (req.method !== "POST") {
    const out = await issueAll(monthKey());
    return json({ ok: true, ranBy: "schedule", ...out });
  }

  let b; try { b = await req.json(); } catch { b = {}; }

  // Netlify calls scheduled functions with no useful body; treat that as the run.
  if (!b || !b.action) {
    const out = await issueAll(monthKey());
    return json({ ok: true, ranBy: "schedule", ...out });
  }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const mk = monthKey();
  const code = (b.code || "").toString().toUpperCase();

  if (b.action === "status") {
    if (!code) return json({ error: "No membership code." }, 400);
    const rec = await readPasses(code, mk);
    if (!rec) {
      // Not issued yet (mid-month signup, or the run hasn't happened). Work out
      // the entitlement so staff still know what this family is owed.
      const m = (await allMembers()).find(x => x && String(x.code).toUpperCase() === code);
      if (!m) return json({ ok: true, found: false });
      return json({ ok: true, found: true, month: mk, total: passesFor(m), used: 0,
                    remaining: passesFor(m), notYetIssued: true });
    }
    const used = (rec.uses || []).length;
    return json({ ok: true, found: true, month: mk, total: rec.total, used,
                  remaining: Math.max(0, rec.total - used), expiresOn: rec.expiresOn,
                  uses: rec.uses || [] });
  }

  if (b.action === "redeem") {
    if (!code) return json({ error: "No membership code." }, 400);
    // Issue on demand if the month's passes aren't there yet, so a family that
    // joined mid-month isn't told they have none.
    if (!(await readPasses(code, mk))) {
      const m = (await allMembers()).find(x => x && String(x.code).toUpperCase() === code);
      if (m && isActive(m)) await issueFor(m, mk);
    }
    const r = await redeem(code, b.by, mk);
    return json(r.ok ? { ok: true, ...r } : { error: r.error, ...r }, r.ok ? 200 : 400);
  }

  if (b.action === "undo") {
    const r = await undo(code, mk);
    return json(r.ok ? { ok: true, ...r } : { error: r.error }, r.ok ? 200 : 400);
  }

  if (b.action === "issue-now") {
    const out = await issueAll(mk);
    return json({ ok: true, ranBy: "staff", ...out,
      message: `${out.passesIssued} pass${out.passesIssued === 1 ? "" : "es"} issued to ${out.issued} membership${out.issued === 1 ? "" : "s"} for ${mk}.` +
               (out.already ? ` ${out.already} already had theirs.` : "") });
  }

  return json({ error: "Unknown action." }, 400);
};

// 1st of the month, 15:00 UTC — the same hour the other daily jobs run.
export const config = { path: "/api/guest-pass", schedule: "0 15 1 * *" };
