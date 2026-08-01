// GET /api/promo-image?id=PROMO_ID — public. Returns the stored promo image.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const id = new URL(req.url).searchParams.get("id") || "";
  const store = getStore("promos");
  let p = null, b64 = null;
  try { p = await store.get("promo:" + id, { type: "json" }); } catch { p = null; }
  try { b64 = await store.get("img:" + id, { type: "text" }); } catch { b64 = null; }
  if (!p || !b64 || !p.imageMime) return new Response("Not found", { status: 404 });
  const bytes = Buffer.from(b64, "base64");
  return new Response(bytes, { status: 200, headers: { "content-type": p.imageMime, "cache-control": "public, max-age=300" } });
};

export const config = { path: "/api/promo-image" };
