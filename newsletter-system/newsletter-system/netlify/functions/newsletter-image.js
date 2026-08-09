// GET /api/newsletter-image?id=CAMPAIGN_ID — public. Serves the promo/event
// image attached to a newsletter campaign (referenced by the sent emails).
import { getStore } from "@netlify/blobs";
import { STORE } from "./lib-newsletter.js";

export default async (req) => {
  const id = new URL(req.url).searchParams.get("id") || "";
  const store = getStore(STORE);
  let c = null, b64 = null;
  try { c = await store.get("campaign:" + id, { type: "json" }); } catch { c = null; }
  try { b64 = await store.get("cimg:" + id, { type: "text" }); } catch { b64 = null; }
  if (!c || !b64 || !c.imageMime) return new Response("Not found", { status: 404 });
  const bytes = Buffer.from(b64, "base64");
  return new Response(bytes, { status: 200, headers: { "content-type": c.imageMime, "cache-control": "public, max-age=600" } });
};

export const config = { path: "/api/newsletter-image" };
