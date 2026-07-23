// GET /api/refill-unsubscribe?e=EMAIL&t=TOKEN  — one-click opt-out from refill reminders.
import { getStore } from "@netlify/blobs";
import { unsubToken } from "./lib-refill.js";

export default async (req) => {
  const url = new URL(req.url);
  const email = (url.searchParams.get("e") || "").toLowerCase().trim();
  const t = (url.searchParams.get("t") || "").trim();
  if (!email || t !== unsubToken(email)) return page("This unsubscribe link isn't valid. Please email hello@littlehavenplay.com and we'll take care of it.", false);
  try {
    const site = getStore("site");
    const o = (await site.get("refillOptout", { type: "json" })) || {};
    o[email] = true;
    await site.setJSON("refillOptout", o);
  } catch { return page("Something went wrong on our end. Please email hello@littlehavenplay.com.", false); }
  return page("You're unsubscribed from refill reminders. We'll still be here whenever you'd like to come back! 💛", true);
};

function page(msg, ok) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Refill reminders</title><div style="font-family:-apple-system,system-ui,Arial,sans-serif;max-width:480px;margin:60px auto;padding:0 22px;text-align:center;color:#2a2622"><div style="font-size:44px">${ok ? "✅" : "⚠️"}</div><h2 style="color:#a85f59;font-weight:400">${ok ? "All set" : "Hmm…"}</h2><p style="color:#5c6470;line-height:1.6">${msg}</p></div>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
export const config = { path: "/api/refill-unsubscribe" };
