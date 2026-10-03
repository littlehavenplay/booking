// GET /api/invite-photo?i=<invitation id>  — the host's uploaded invitation photo.
import { invitesStore } from "./lib-invite.js";

export default async (req) => {
  const id = (new URL(req.url).searchParams.get("i") || "").toLowerCase();
  if (!/^[a-z0-9]{6,20}$/.test(id)) return new Response("Not found", { status: 404 });
  let p = null; try { p = await invitesStore().get("photo:" + id, { type: "json" }); } catch {}
  if (!p || !p.b64) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(p.b64, "base64"), {
    status: 200,
    headers: { "content-type": p.type || "image/jpeg", "cache-control": "public, max-age=86400" },
  });
};
export const config = { path: "/api/invite-photo" };
