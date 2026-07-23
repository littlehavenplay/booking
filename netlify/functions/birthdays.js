// POST /api/birthdays  (admin key or staff PIN)
//   { key, action:"list", month:"09" | "all" }  → children with birthdays that month + parent contact
//   { key, action:"setdob", code, dob }          → backfill/edit a birth date on an existing loyalty card
//   { key, action:"send", code }                 → generate + email that child's birthday gift code now
//   { key, action:"remove", code }                → forget a child's birthday (keeps the loyalty card + punch history)
//
// Source of truth: the loyalty card itself (card.dob). Birthday gift codes reuse the
// free-visit reward mechanism (one free child admission). They are valid on the
// birthday ONLY (validFrom === expiry === the birthday) and single-use.
import { getStore } from "@netlify/blobs";
import { nextOccurrence, ageOn, issueBirthdayCode } from "./lib-birthday.js";
import { normalizeCode } from "./lib-loyalty.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const loyalty = getStore("loyalty");
  const action = (b.action || "list").toString();

  if (action === "list") {
    const monthRaw = (b.month || "").toString();
    const all = monthRaw === "all";
    const month = monthRaw.padStart(2, "0");
    if (!all && !/^(0[1-9]|1[0-2])$/.test(month)) return json({ error: "Pick a month." }, 400);
    let keys = [];
    try { const r = await loyalty.list({ prefix: "card:" }); keys = (r.blobs || []).map(x => x.key); } catch {}
    const rows = [];
    for (const k of keys) {
      let rec = null; try { rec = await loyalty.get(k, { type: "json" }); } catch {}
      if (!rec || !rec.dob) continue;
      const cmm = rec.dob.slice(5, 7), cdd = rec.dob.slice(8, 10);
      if (!all && cmm !== month) continue;
      const parts = (rec.childName || "").trim().split(/\s+/);
      rows.push({
        code: rec.code || k.slice(5), first: parts[0] || "", last: parts.slice(1).join(" ") || "",
        dob: rec.dob, month: cmm, day: cdd,
        turning: ageOn(rec.dob, nextOccurrence(rec.dob)),
        email: rec.buyerEmail || "", phone: rec.phone || "",
        lastSentYear: rec.lastSentYear || null, lastCode: rec.lastCode || "",
      });
    }
    // Sort by month+day together (not day alone) — otherwise "all months" mode would
    // group every 1st-of-the-month before every 2nd, regardless of which month.
    rows.sort((a, c) => ((a.month || "") + (a.day || "")).localeCompare((c.month || "") + (c.day || "")));
    return json({ ok: true, month: all ? "all" : month, rows, count: rows.length });
  }

  if (action === "setdob") {
    const code = normalizeCode(b.code);
    const dob = (b.dob || "").toString().trim();
    if (!code) return json({ error: "Missing loyalty code." }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return json({ error: "Enter the birth date as YYYY-MM-DD." }, 400);
    let card = null; try { card = await loyalty.get("card:" + code, { type: "json" }); } catch {}
    if (!card) return json({ error: `No loyalty card found for ${code}.` }, 404);
    card.dob = dob;
    try { await loyalty.setJSON("card:" + code, card); } catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, message: `Birth date saved for ${card.childName || code}.` });
  }

  if (action === "remove") {
    const code = normalizeCode(b.code);
    if (!code) return json({ error: "Missing loyalty code." }, 400);
    let card = null; try { card = await loyalty.get("card:" + code, { type: "json" }); } catch {}
    if (!card) return json({ error: "That child's record wasn't found." }, 404);
    // Only forgets the birthday — the loyalty card and punch history stay intact.
    delete card.dob; delete card.lastSentYear; delete card.lastCode; delete card.lastSentAt;
    delete card.dayOfSentYear; delete card.activeBirthdayCode; delete card.activeBirthdayExpiry;
    try { await loyalty.setJSON("card:" + code, card); } catch {}
    return json({ ok: true });
  }

  if (action === "send") {
    const code = normalizeCode(b.code);
    if (!code) return json({ error: "Missing loyalty code." }, 400);
    let card = null; try { card = await loyalty.get("card:" + code, { type: "json" }); } catch {}
    if (!card) return json({ error: "That child's record wasn't found." }, 404);
    if (!card.dob) return json({ error: "No birth date on file for this card yet." }, 400);
    if (!card.buyerEmail) return json({ error: `No email on file for ${card.childName || "this child"} — text them the code instead.` }, 400);

    const parts = (card.childName || "").trim().split(/\s+/);
    const first = parts[0] || "", last = parts.slice(1).join(" ") || "";
    const when = nextOccurrence(card.dob);
    const result = await issueBirthdayCode({ first, last, email: card.buyerEmail, dob: card.dob, code }, when, code);
    if (!result.ok) return json({ error: result.error }, 502);

    card.lastSentYear = when.slice(0, 4);
    card.lastCode = result.code;
    card.lastSentAt = new Date().toISOString();
    try { await loyalty.setJSON("card:" + code, card); } catch {}

    return json({ ok: true, code: result.code, when, emailed: result.emailed,
      message: `Birthday gift ${result.code} for ${first} — good on ${when}.` +
               (result.emailed ? " Emailed to the family." : " (Email didn't send — share the code directly.)") });
  }

  return json({ error: "Unknown action." }, 400);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/birthdays" };
