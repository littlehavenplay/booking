// GET /api/partner-logo?id=PARTNER_ID — public. Returns an uploaded partner logo image.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const id = new URL(req.url).searchParams.get("id") || "";
  const store = getStore("site");
  let b64 = null;
  try { b64 = await store.get("plogo:" + id, { type: "text" }); } catch { b64 = null; }
  if (!b64) return new Response("Not found", { status: 404 });
  let rec = null;
  try { rec = await store.get("partners", { type: "json" }); } catch {}
  const p = Array.isArray(rec) ? rec.find(x => x.id === id) : null;
  const mime = (p && p.logoMime) || "image/png";
  const bytes = Buffer.from(b64, "base64");
  return new Response(bytes, { status: 200, headers: { "content-type": mime, "cache-control": "public, max-age=300" } });
};

export const config = { path: "/api/partner-logo" };
