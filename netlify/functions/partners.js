// GET  /api/partners            — public. Returns { partners:[{name,logo,url,blurb,perk,active}] }.
// POST /api/partners             — admin/staff. Body: { key, action:"save", partners:[...] }
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const store = getStore("site");

  if (req.method === "GET") {
    let rec = null;
    try { rec = await store.get("partners", { type: "json" }); } catch { rec = null; }
    return json({ partners: Array.isArray(rec) ? rec : [] });
  }

  if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  if ((b.action || "save") !== "save") return json({ error: "Unknown action." }, 400);

  const list = (Array.isArray(b.partners) ? b.partners : [])
    .map(p => ({
      name: (p && p.name || "").toString().slice(0, 120).trim(),
      logo: (p && p.logo || "").toString().slice(0, 300).trim(),
      url: (p && p.url || "").toString().slice(0, 300).trim(),
      blurb: (p && p.blurb || "").toString().slice(0, 300).trim(),
      perk: (p && p.perk || "").toString().slice(0, 500).trim(),
      active: p && p.active !== false,
    }))
    .filter(p => p.name)
    .slice(0, 40);

  try { await store.setJSON("partners", list); }
  catch { return json({ error: "Couldn't save. Try again." }, 502); }
  return json({ ok: true, partners: list });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/partners" };
