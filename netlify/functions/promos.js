// GET /api/promos — public. Ongoing promo/flyer posts, newest first, until removed.
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";

export default async () => {
  const store = getStore("promos");
  const keys = await listAllKeys(store, { prefix: "promo:" });
  const promos = [];
  for (const k of keys) {
    let p = null; try { p = await store.get(k, { type: "json" }); } catch {}
    if (p && p.imageMime) promos.push({ id: p.id, caption: p.caption || "", createdAt: p.createdAt });
  }
  promos.sort((a, c) => (c.createdAt || "").localeCompare(a.createdAt || ""));
  return json({ promos });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/promos" };
