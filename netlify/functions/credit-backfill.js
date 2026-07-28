// POST /api/credit-backfill  (admin key or staff PIN)
// Old credits (issued before credits started storing who they belong to) have no
// email on file, so the expiry-reminder cron can't reach them. This tool finds
// those and lets staff attach an email by hand, one code at a time.
//   { key, action:"list" }                      → active credits missing an email
//   { key, action:"set", code, email, custName? } → attach an email (+ optional name)
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("credits");
  const action = (b.action || "list").toString();

  if (action === "set") {
    const code = (b.code || "").toString().trim().toUpperCase();
    const email = (b.email || "").toString().trim();
    if (!code) return json({ error: "Missing code." }, 400);
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
    let rec = null; try { rec = await store.get("credit:" + code, { type: "json" }); } catch {}
    if (!rec) return json({ error: `Credit ${code} wasn't found.` }, 404);
    rec.email = email;
    if (b.custName) rec.custName = (b.custName || "").toString().slice(0, 80).trim();
    try { await store.setJSON("credit:" + code, rec); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, message: `Saved — ${code} is now linked to ${email}.` });
  }

  // list: every active, unused credit that's missing an email
  let keys = [];
  try { const r = await store.list({ prefix: "credit:" }); keys = (r.blobs || []).map(x => x.key); } catch {}
  const rows = [];
  for (const k of keys) {
    let rec = null; try { rec = await store.get(k, { type: "json" }); } catch {}
    if (!rec) continue;
    if (rec.active === false || !(rec.amount > 0)) continue;   // fully used / deactivated — no need to backfill
    if (rec.email) continue;                                    // already has one
    rows.push({ code: rec.code, custName: rec.custName || "", reason: rec.reason || "", type: rec.type || "",
      amount: rec.amount || 0, expiry: rec.expiry || "", createdAt: rec.createdAt || "" });
  }
  rows.sort((a, c) => (c.createdAt || "").localeCompare(a.createdAt || ""));
  return json({ ok: true, rows, count: rows.length });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/credit-backfill" };
