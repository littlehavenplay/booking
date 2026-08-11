// /api/site-photos — manage website photo sets ("reviews", "yelp", "facebook", "interior", "customer").
//
//   GET  ?set=X                 → public: ordered, merged list of built-in + uploaded photos
//                                  { ok, set, photos:[{id,kind:"static"|"upload",src,thumb}] }
//   GET  ?set=X&id=ABC          → public: serve an uploaded photo's bytes
//   POST { key, action:"upload",  set, dataUrl }        (admin/staff) — add a new photo
//   POST { key, action:"delete",  set, id }             (admin/staff) — remove upload, or
//                                                          hide a built-in photo from the site
//   POST { key, action:"restore", set, id }             (admin/staff) — unhide a built-in photo
//   POST { key, action:"reorder", set, order:[id,...] } (admin/staff) — save display order
//
// Built-in photos ship with the site as real files and can't be deleted from here — "delete"
// on one of those just hides it from the site (recorded in blob storage); it can be restored.
import { getStore } from "@netlify/blobs";

const SETS = ["reviews", "yelp", "facebook", "interior", "customer", "pastevents"];

// Built-in (repo) photos per set.
const STATIC = {
  interior: Array.from({ length: 11 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return { id: "static-inside-" + n, src: "/assets/photos/inside-" + n + ".jpg", thumb: "/assets/photos/inside-" + n + "t.jpg" };
  }),
  reviews: Array.from({ length: 9 }, (_, i) => {
    const n = i + 1;
    return { id: "static-review-" + n, src: "/assets/reviews/review-" + n + ".png", thumb: "/assets/reviews/review-" + n + ".png" };
  }),
  customer: [],
};

export default async (req) => {
  const store = getStore("sitephotos");
  const url = new URL(req.url);

  // ---- GET: public list or image serving ----
  if (req.method === "GET") {
    const set = (url.searchParams.get("set") || "").toLowerCase();
    if (!SETS.includes(set)) return json({ error: "Unknown set." }, 400);

    const id = url.searchParams.get("id");
    if (id) {
      let rec = null;
      try { rec = await store.get(set + ":" + id, { type: "json" }); } catch {}
      if (!rec || !rec.b64) return new Response("Not found", { status: 404 });
      const bytes = Buffer.from(rec.b64, "base64");
      return new Response(bytes, { status: 200, headers: { "content-type": rec.mime || "image/png", "cache-control": "public, max-age=600" } });
    }

    let uploaded = [];
    try {
      const { blobs } = await store.list({ prefix: set + ":" });
      uploaded = (blobs || [])
        .map((b) => b.key.slice(set.length + 1))
        .filter((uid) => uid.indexOf("meta:") !== 0)
        .map((uid) => ({ id: uid, kind: "upload", src: "/api/site-photos?set=" + set + "&id=" + uid, thumb: "/api/site-photos?set=" + set + "&id=" + uid }));
    } catch {}

    let hidden = [];
    try { hidden = (await store.get("meta:" + set + ":hidden", { type: "json" })) || []; } catch {}
    let order = [];
    try { order = (await store.get("meta:" + set + ":order", { type: "json" })) || []; } catch {}

    const statics = (STATIC[set] || [])
      .filter((s) => hidden.indexOf(s.id) === -1)
      .map((s) => ({ id: s.id, kind: "static", src: s.src, thumb: s.thumb }));

    let all = statics.concat(uploaded);
    if (order.length) {
      const pos = {};
      order.forEach((oid, i) => { pos[oid] = i; });
      all = all
        .map((item, i) => ({ item, i }))
        .sort((a, b) => {
          const pa = Object.prototype.hasOwnProperty.call(pos, a.item.id) ? pos[a.item.id] : 9999 + a.i;
          const pb = Object.prototype.hasOwnProperty.call(pos, b.item.id) ? pos[b.item.id] : 9999 + b.i;
          return pa - pb;
        })
        .map((x) => x.item);
    }

    return json({ ok: true, set, photos: all });
  }

  // ---- POST: admin actions ----
  if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const set = (b.set || "").toLowerCase();
  if (!SETS.includes(set)) return json({ error: "Unknown set." }, 400);
  const action = (b.action || "").toString();

  if (action === "upload") {
    const du = (b.dataUrl || "").toString();
    const m = du.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return json({ error: "That doesn't look like an image." }, 400);
    const mime = m[1], b64 = m[2];
    if (b64.length > 7000000) return json({ error: "Image is too large — please use one under ~5MB." }, 400);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    try { await store.setJSON(set + ":" + id, { mime, b64, at: new Date().toISOString() }); }
    catch { return json({ error: "Couldn't save the photo. Try again." }, 502); }
    return json({ ok: true, id });
  }

  if (action === "delete") {
    const id = (b.id || "").toString();
    if (!id) return json({ error: "Missing photo id." }, 400);
    if (id.indexOf("static-") === 0) {
      let hidden = [];
      try { hidden = (await store.get("meta:" + set + ":hidden", { type: "json" })) || []; } catch {}
      if (hidden.indexOf(id) === -1) hidden.push(id);
      try { await store.setJSON("meta:" + set + ":hidden", hidden); }
      catch { return json({ error: "Couldn't hide photo." }, 502); }
      return json({ ok: true, hidden: true });
    }
    try { await store.delete(set + ":" + id); } catch {}
    return json({ ok: true });
  }

  if (action === "restore") {
    const id = (b.id || "").toString();
    if (!id) return json({ error: "Missing photo id." }, 400);
    let hidden = [];
    try { hidden = (await store.get("meta:" + set + ":hidden", { type: "json" })) || []; } catch {}
    hidden = hidden.filter((x) => x !== id);
    try { await store.setJSON("meta:" + set + ":hidden", hidden); }
    catch { return json({ error: "Couldn't restore photo." }, 502); }
    return json({ ok: true });
  }

  if (action === "reorder") {
    const order = Array.isArray(b.order) ? b.order.map(String) : null;
    if (!order) return json({ error: "Missing order list." }, 400);
    try { await store.setJSON("meta:" + set + ":order", order); }
    catch { return json({ error: "Couldn't save the new order." }, 502); }
    return json({ ok: true });
  }

  if (action === "list") {
    let out = [];
    try {
      const { blobs } = await store.list({ prefix: set + ":" });
      out = (blobs || []).map(x => ({ id: x.key.slice(set.length + 1) }));
    } catch {}
    return json({ ok: true, photos: out });
  }

  return json({ error: "Unknown action." }, 400);
};

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/site-photos" };
