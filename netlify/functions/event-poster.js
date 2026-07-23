// GET /api/event-poster?id=EVENT_ID — public. Returns the stored poster image.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const id = new URL(req.url).searchParams.get("id") || "";
  const store = getStore("events");
  let e = null, b64 = null;
  try { e = await store.get("event:" + id, { type: "json" }); } catch { e = null; }
  try { b64 = await store.get("poster:" + id, { type: "text" }); } catch { b64 = null; }
  if (!e || !b64 || !e.posterMime) return new Response("Not found", { status: 404 });
  const bytes = Buffer.from(b64, "base64");
  return new Response(bytes, { status: 200, headers: { "content-type": e.posterMime, "cache-control": "public, max-age=300" } });
};

export const config = { path: "/api/event-poster" };
