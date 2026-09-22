// POST /api/buddy-pass   (admin key or staff PIN)
//   { action: "status",    code, month? }     -> this month's passes and who used them
//   { action: "undo",      code, passId, month? }  -> give one pass back
//   { action: "issue-now", month? }           -> run the monthly issue immediately
//
// Redemption is NOT here. Passes are only ever spent inside a member's own
// booking (book.js), so there is no endpoint a friend could use on their own.
// The monthly issuing run lives in buddy-pass-cron.js: Netlify won't allow one
// function to be both scheduled and reachable on a path.

import { getStore } from "@netlify/blobs";
import { readPasses, ensureIssued, release, issueAll, thisMonth, activeForIssue } from "./lib-buddypass.js";
import { recipients, buildEmail, sendOne } from "./lib-buddy-announce.js";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const mk = /^\d{4}-\d{2}$/.test(b.month || "") ? b.month : thisMonth();
  const code = (b.code || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (b.action === "status") {
    if (!code) return json({ error: "No membership code." }, 400);
    let rec = await readPasses(code, mk);
    if (!rec) {
      // Not issued yet (joined mid-month, or before the 1st's run). Issue now if
      // the membership is in good standing, so staff see the real balance.
      let members = [];
      try { members = (await getStore("site").get("playclub:members", { type: "json" })) || []; } catch {}
      const m = members.find(x => x && String(x.code).toUpperCase() === code);
      if (!m) return json({ ok: true, found: false });
      if (!activeForIssue(m, `${mk}-01`) && mk === thisMonth()) {
        const today = new Date().toISOString().slice(0, 10);
        if (!activeForIssue(m, today)) return json({ ok: true, found: true, month: mk, passes: [], inactive: true });
      }
      rec = await ensureIssued(m, mk);
    }
    const passes = (rec && rec.passes) || [];
    return json({ ok: true, found: true, month: mk, expiresOn: rec && rec.expiresOn,
      total: passes.length, used: passes.filter(p => p.used).length,
      remaining: passes.filter(p => !p.used).length, passes });
  }

  if (b.action === "undo") {
    if (!code || !b.passId) return json({ error: "Which pass?" }, 400);
    const r = await release(code, mk, { passId: String(b.passId) });
    return json(r.released ? { ok: true, message: "Pass given back." } : { error: "That pass wasn't in use." }, r.released ? 200 : 400);
  }

  // One-time "you have a new perk" email to existing members. "preview" lists
  // who would get it (and who wouldn't, and why) plus a sample, and sends
  // nothing. "send" emails everyone eligible who hasn't been told yet.
  if (b.action === "announce-preview") {
    const list = await recipients();
    const first = list.find(x => x.eligible);
    return json({ ok: true, total: list.length, willSend: list.filter(x => x.eligible).length,
      list: list.map(x => ({ code: x.code, name: x.name, email: x.email, kids: x.kids, eligible: x.eligible, reason: x.reason, sentAt: x.sentAt })),
      sample: first ? buildEmail(first) : null });
  }
  if (b.action === "announce-send") {
    if (!process.env.RESEND_API_KEY) return json({ error: "Email isn't set up (RESEND_API_KEY)." }, 500);
    const list = (await recipients()).filter(x => x.eligible);
    let sent = 0; const failed = [];
    for (const r of list) { (await sendOne(r)) ? sent++ : failed.push(r.name || r.code); }
    return json({ ok: true, sent, failed,
      message: `Sent to ${sent} member${sent === 1 ? "" : "s"}.` + (failed.length ? ` Couldn't send to: ${failed.join(", ")}.` : "") });
  }

  if (b.action === "issue-now") {
    const out = await issueAll(mk);
    return json({ ok: true, ...out,
      message: `${out.passesIssued} buddy pass${out.passesIssued === 1 ? "" : "es"} issued to ${out.issued} membership${out.issued === 1 ? "" : "s"} for ${mk}.`
        + (out.already ? ` ${out.already} already had theirs.` : "") });
  }

  return json({ error: "Unknown action." }, 400);
};

export const config = { path: "/api/buddy-pass" };
