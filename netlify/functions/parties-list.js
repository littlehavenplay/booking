// POST /api/parties-list  (admin key or staff PIN)
//   { key }                              -> all parties, chronological (soonest first)
//   { key, action:"mark-paid", date, partySlot, paid } -> toggle deposit paid
import { getStore } from "@netlify/blobs";
import { slotKey } from "./lib-settings.js";
import { sendPartyConfirmedOnce } from "./lib-party-confirm.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "", provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("parties");

  if ((b.action || "") === "mark-paid") {
    const k = slotKey((b.date || "").toString(), (b.partySlot || "").toString());
    let r = null;
    try { r = await store.get(k, { type: "json" }); } catch {}
    if (!r) return json({ error: "Party not found." }, 404);
    r.depositPaid = !!b.paid;
    if (r.depositPaid && r.status === "pending-deposit") r.status = "deposit-paid";
    try { await store.setJSON(k, r); } catch { return json({ error: "Couldn't save. Try again." }, 502); }
    // One confirmation per party, ever — re-marking paid never re-sends.
    let emailed = "";
    if (b.paid) { try { emailed = await sendPartyConfirmedOnce(k, r); } catch {} }
    return json({ ok: true, emailed });
  }

  let keys = [];
  try { const r = await store.list(); keys = (r.blobs || []).map(x => x.key); } catch {}
  const parties = [];
  for (const k of keys) {
    try {
      const r = await store.get(k, { type: "json" });
      if (!r || !r.date || !r.partySlot) continue;
      parties.push({
        date: r.date, partySlot: r.partySlot, slotLabel: r.slotLabel || "",
        package: r.packageLabel || r.package || "", deposit: r.deposit || 0,
        childName: r.childName || "", name: r.name || "", phone: r.phone || "", email: r.email || "",
        kids: r.kids || null, adults: r.adults || null,
        status: r.status || "", depositPaid: !!r.depositPaid, at: r.at || "",
        promo: r.promo || null,
      });
    } catch {}
  }
  parties.sort((a, c) => (a.date + a.partySlot).localeCompare(c.date + c.partySlot));
  return json({ ok: true, parties, count: parties.length });
};
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
export const config = { path: "/api/parties-list" };
