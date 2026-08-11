// POST /api/grandfather-send  (admin key or staff PIN)
//   { key, action:"count" }  -> dry run: how many legacy holders would get the note (no send)
//   { key, action:"send"  }  -> send the one-time grandfather note now
// Each holder is still emailed at most once, ever (tracked in site/grandfatherSent),
// so pressing Send repeatedly can't spam anyone.
import { runRefillCampaign } from "./lib-refill.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const dryRun = (b.action || "count").toString() !== "send";
  const r = await runRefillCampaign({ dryRun });

  const message = dryRun
    ? (r.candidates === 0
        ? "No one is waiting for the note right now — everyone eligible has already received it (or has an active card)."
        : `${r.candidates} legacy holder${r.candidates === 1 ? "" : "s"} would receive the grandfather note. Nothing sent yet — press “Send now” to send it.`)
    : (!process.env.RESEND_API_KEY
        ? "Email isn't configured (RESEND_API_KEY), so nothing was sent."
        : `Sent the grandfather note to ${r.sent} legacy holder${r.sent === 1 ? "" : "s"}. They won't be emailed again.`);

  return json({ ok: true, dryRun, ...r, message });
};

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/grandfather-send" };
