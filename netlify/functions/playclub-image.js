// GET /api/playclub-image?id=PLAN_ID  — public. Serves a plan icon.
// GET /api/playclub-image?banner=1    — public. Serves the page banner.
//
// Same approach as the partner logos: the bytes live in Blobs and are served
// from here, so the page has no dependency on an outside image host.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const store = getStore("site");
  const isBanner = q.get("banner") === "1";
  const id = (q.get("id") || "").toString();
  if (!isBanner && !id) return new Response("Not found", { status: 404 });

  const key = isBanner ? "playclub:banner" : "playclub:img:" + id;
  let b64 = null;
  try { b64 = await store.get(key, { type: "text" }); } catch { b64 = null; }
  if (!b64) return new Response("Not found", { status: 404 });

  let mime = "image/png";
  try {
    if (isBanner) {
      const meta = await store.get("playclub:meta", { type: "json" });
      if (meta && meta.bannerMime) mime = meta.bannerMime;
    } else {
      const plans = (await store.get("playclub:plans", { type: "json" })) || [];
      const p = plans.find(x => x && x.id === id);
      if (p && p.imageMime) mime = p.imageMime;
    }
  } catch {}

  return new Response(Buffer.from(b64, "base64"), {
    status: 200,
    headers: { "content-type": mime, "cache-control": "public, max-age=300" },
  });
};

export const config = { path: "/api/playclub-image" };
