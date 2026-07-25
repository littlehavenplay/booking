// POST /api/failed-redemptions  (admin key or staff PIN)
// Lists free-visit/birthday/classroom codes that failed at checkout, with whoever's
// name/email/phone was on the booking form at the time — so a family that got stuck
// can be followed up with directly instead of guessing who tried.
// Body: { key, action:"list" }
//       { key, action:"clear", id }   — dismiss one entry once you've followed up
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("failed-redemptions");
  const action = (b.action || "list").toString();

  if (action === "clear") {
    const id = (b.id || "").toString().trim();
    if (!id) return json({ error: "Missing id." }, 400);
    try { await store.delete("fail:" + id); } catch {}
    return json({ ok: true });
  }

  let keys = [];
  try { const r = await store.list({ prefix: "fail:" }); keys = (r.blobs || []).map(x => x.key); } catch {}
  const rows = [];
  for (const k of keys) {
    let rec = null; try { rec = await store.get(k, { type: "json" }); } catch {}
    if (!rec) continue;
    rows.push({ id: k.slice(5), code: rec.code || "", reason: rec.reason || "", name: rec.name || "", email: rec.email || "", phone: rec.phone || "", at: rec.at || "" });
  }
  rows.sort((a, c) => (c.at || "").localeCompare(a.at || ""));
  return json({ ok: true, rows, count: rows.length });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/failed-redemptions" };
