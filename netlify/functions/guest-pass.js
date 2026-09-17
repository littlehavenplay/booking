// POST /api/guest-pass   (admin key or staff PIN)
//   { action: "status",  code }            -> this month's balance
//   { action: "redeem",  code, by }        -> spend one
//   { action: "undo",    code }            -> put the last one back
//   { action: "issue-now" }                -> run the monthly issue immediately
//
// The monthly issuing run lives in guest-pass-cron.js. Netlify does not allow a
// function to be both scheduled AND reachable on a custom path, so the two are
// deliberately separate files sharing one library.

import { issueFor, redeem, undo, readPasses, monthKey, passesFor, allMembers, isActiveMember, issueAll } from "./lib-guestpass.js";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { b = {}; }
  if (!b || !b.action) return json({ error: "No action." }, 400);

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

export const config = { path: "/api/guest-pass" };
