// POST /api/contacts-export — admin/staff: gather all customer contacts (name, email, phone)
// from bookings + loyalty cards, de-duplicated, for future mass email / text campaigns.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const seen = new Set();
  const rows = [];
  const add = (name, email, phone) => {
    email = (email || "").toString().trim().toLowerCase();
    phone = (phone || "").toString().replace(/\D/g, "");
    if (phone.length === 11 && phone[0] === "1") phone = phone.slice(1);
    const k = email || (phone ? "p:" + phone : "");
    if (!k || seen.has(k)) return;
    seen.add(k);
    rows.push({ name: (name || "").toString().trim(), email, phone });
  };

  // 1) Bookings — have full name, email, and phone.
  try {
    const store = getStore("bookings");
    const { blobs } = await store.list();
    for (const bl of (blobs || [])) {
      let rec = null; try { rec = await store.get(bl.key, { type: "json" }); } catch {}
      if (rec && Array.isArray(rec.bookings)) {
        for (const bk of rec.bookings) add(bk.name || bk.parentName, bk.email, bk.phone);
      }
    }
  } catch {}

  // 2) Loyalty cards — email on file (phone stored only as last 4, so not used for texting).
  try {
    const loy = getStore("loyalty");
    const { blobs } = await loy.list({ prefix: "card:" });
    for (const bl of (blobs || [])) {
      let r = null; try { r = await loy.get(bl.key, { type: "json" }); } catch {}
      if (r && r.buyerEmail) add(r.childName, r.buyerEmail, "");
    }
  } catch {}

  const emails = [...new Set(rows.map(r => r.email).filter(Boolean))];
  const phones = [...new Set(rows.map(r => r.phone).filter(p => p && p.length >= 10))];
  const esc = v => `"${(v || "").replace(/"/g, '""')}"`;
  const csv = "Name,Email,Phone\n" + rows.map(r => [esc(r.name), esc(r.email), esc(r.phone)].join(",")).join("\n");

  return json({ ok: true, total: rows.length, emailCount: emails.length, phoneCount: phones.length, emails, phones, csv });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/contacts-export" };
