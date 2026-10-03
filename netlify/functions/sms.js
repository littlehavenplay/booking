// POST /api/sms — the text-message opt-in list (see lib-sms.js for the why).
//
// Public:
//   { action:"subscribe", phone, name, consent:true }   from /texts.html
//   { action:"unsubscribe", phone }                     web opt-out
// Staff (admin key or staff PIN):
//   { action:"stats", key }                             counts + latest sign-ups
//   { action:"export", key }                            CSV of everyone opted in
//   { action:"add", key, phone, name, confirmed:true }  someone who agreed in person
//   { action:"import-optouts", key, text }              paste STOPs from the texting service
import { subscribe, unsubscribe, listAll, normPhone, prettyPhone, CONSENT_TEXT, POPUP_CONSENT_TEXT } from "./lib-sms.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = String(b.action || "");

  if (action === "subscribe") {
    if (String(b.website || "").trim()) return json({ ok: true });          // bot trap
    if (b.consent !== true) return json({ error: "Please tick the box to agree to texts." }, 400);
    if (!normPhone(b.phone)) return json({ error: "Enter a 10-digit US mobile number." }, 400);
    const source = String(b.source || "signup-page").slice(0, 40);
    // Save the exact wording this person saw when they agreed.
    const r = await subscribe({ phone: b.phone, name: b.name, source, consentText: source === "site-popup" ? POPUP_CONSENT_TEXT : CONSENT_TEXT, reoptin: true });
    return json(r.ok ? { ok: true, already: !!r.already } : { error: r.error }, r.ok ? 200 : 400);
  }
  if (action === "unsubscribe") {
    if (!normPhone(b.phone)) return json({ error: "Enter the 10-digit number you signed up with." }, 400);
    await unsubscribe(b.phone, "website");
    return json({ ok: true });   // same answer whether or not the number was on the list
  }

  const provided = String(b.key || "");
  const ok = (process.env.ADMIN_KEY && provided === process.env.ADMIN_KEY) || (process.env.STAFF_PIN && provided === process.env.STAFF_PIN);
  if (!ok) return json({ error: "Wrong key." }, 401);

  if (action === "stats" || action === "export") {
    const all = await listAll();
    const subs = all.filter(r => r.status === "subscribed").sort((a, c) => String(c.consentAt).localeCompare(String(a.consentAt)));
    if (action === "export") {
      const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
      const csv = ["Phone,First Name,Opted In,Source"].concat(subs.map(r =>
        [q("+1" + r.phone), q(String(r.name || "").split(/\s+/)[0]), q(String(r.consentAt || "").slice(0, 10)), q(r.source || "")].join(","))).join("\n");
      return json({ ok: true, csv, count: subs.length });
    }
    const bySource = {};
    subs.forEach(r => { bySource[r.source || "website"] = (bySource[r.source || "website"] || 0) + 1; });
    return json({ ok: true, subscribed: subs.length, optedOut: all.filter(r => r.status === "unsubscribed").length, bySource,
      latest: subs.slice(0, 8).map(r => ({ name: r.name || "", phone: prettyPhone(r.phone), at: r.consentAt, source: r.source || "" })) });
  }
  if (action === "add") {
    if (b.confirmed !== true) return json({ error: "Only add people who agreed to marketing texts. Tick the box to confirm." }, 400);
    const r = await subscribe({ phone: b.phone, name: b.name, source: "in-person (staff)", consentText: "Agreed in person / on paper; recorded by staff. " + CONSENT_TEXT });
    if (!r.ok) return json({ error: r.error }, 400);
    if (r.skipped === "opted-out") return json({ error: "That number opted out earlier. They need to sign up again themselves at littlehavenplay.com/texts.html." }, 409);
    return json({ ok: true, message: r.already ? "Already on the list." : "Added " + prettyPhone(r.phone) + "." });
  }
  if (action === "import-optouts") {
    const nums = String(b.text || "").split(/[\n,;]+/).map(normPhone).filter(Boolean);
    let n = 0; for (const p of [...new Set(nums)]) { const r = await unsubscribe(p, "texting service STOP"); if (r.ok && !r.already) n++; }
    return json({ ok: true, message: n + " number" + (n === 1 ? "" : "s") + " marked as opted out." + (nums.length ? "" : " No phone numbers found in what you pasted.") });
  }
  return json({ error: "Unknown action." }, 400);
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/sms" };
