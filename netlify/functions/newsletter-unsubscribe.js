// /api/newsletter-unsubscribe?e=<email>&t=<token>   (public)
//   GET  -> the link in the email footer. Removes them from the active list
//           immediately and shows a friendly confirmation page.
//   POST -> the same, for Gmail/Apple "List-Unsubscribe-Post" one-click.
// Either way the studio owner is notified, and the subscriber stops appearing
// in the admin's active list right away (no manual step needed).
import { newsletterStore, cleanEmail, subKey, suppress } from "./lib-newsletter.js";
import { sendOwnerAlert } from "./lib-email.js";

async function doUnsub(email, token) {
  const store = newsletterStore();
  let rec = null;
  try { rec = await store.get(subKey(email), { type: "json" }); } catch {}
  if (!rec) return { ok: true, alreadyGone: true };
  // token check (skip only if the record never had one, for older entries)
  if (rec.token && token && rec.token !== token) return { ok: false, badToken: true };

  if (rec.active !== false) {
    rec.active = false;
    rec.unsubscribedAt = new Date().toISOString();
    try { await store.setJSON(subKey(email), rec); } catch {}
    // Permanent block, so a future CSV import can't quietly put them back.
    await suppress(store, email, "unsubscribed");
    // Heads-up to the owner (best-effort; never blocks the unsubscribe).
    sendOwnerAlert(
      "📭 Newsletter unsubscribe",
      `<b>${escapeHtml(rec.name || email)}</b> (${escapeHtml(email)}) just unsubscribed from the newsletter and has been removed from your active list automatically.`
    ).catch(() => {});
  }
  return { ok: true };
}

export default async (req) => {
  const url = new URL(req.url);
  const email = cleanEmail(url.searchParams.get("e") || "");
  const token = url.searchParams.get("t") || "";

  if (!email) return page("That link looks incomplete.", "If you meant to unsubscribe, reply to any of our emails and we'll take care of it.", false);

  const r = await doUnsub(email, token);

  if (req.method === "POST") {
    // one-click (RFC 8058) — just needs a 200
    return new Response(JSON.stringify({ ok: r.ok }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (r.badToken) return page("We couldn't verify that link.", "For your safety we didn't change anything. Reply to any of our emails and we'll remove you manually.", false);
  return page("You're unsubscribed. 💌", "You won't receive any more newsletters from Little Haven Play Studio. Changed your mind? You can always opt back in from our website.", true);
};

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function page(title, sub, ok) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=Nunito:wght@600;700;800&display=swap" rel="stylesheet">
  <style>body{margin:0;font-family:'Nunito',sans-serif;background:radial-gradient(1100px 480px at 110% -8%,#fdf1ec 0,transparent 55%),#faf7f3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;color:#2a2622}
  .box{background:#fff;border:1px solid #efe4d5;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,.06);max-width:460px;padding:34px 30px;text-align:center}
  h1{font-family:'Cormorant Garamond',serif;font-weight:500;font-size:2rem;margin:0 0 10px;color:${ok ? "#4d7848" : "#a85f59"}}
  p{color:#5c6470;line-height:1.6;font-size:1rem;margin:0 0 18px}
  a.btn{display:inline-block;background:#c97d76;color:#fff;text-decoration:none;font-weight:800;padding:12px 26px;border-radius:40px;font-size:.9rem}</style></head>
  <body><div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(sub)}</p><a class="btn" href="/index.html">← Back to Little Haven</a></div></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
export const config = { path: "/api/newsletter-unsubscribe" };
