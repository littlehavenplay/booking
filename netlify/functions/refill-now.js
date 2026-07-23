// Admin-triggered manual run of the refill campaign (for testing / sending early).
//   { key, dryRun?:true }  -> dryRun counts who WOULD get an email without sending.
import { runRefillCampaign } from "./lib-refill.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }
  const key = (b.key || "").toString().trim();
  if (!key || (key !== process.env.ADMIN_KEY && key !== process.env.STAFF_PIN)) return json({ error: "Not authorised." }, 403);
  const summary = await runRefillCampaign({ dryRun: !!b.dryRun });
  return json({ ok: true, ...summary });
};
function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
export const config = { path: "/api/refill-now" };
