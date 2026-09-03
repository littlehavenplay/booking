// POST /api/code-lookup  (admin key or staff PIN)
// Front-desk "look up any code" — paste a punch card, store credit, or gift card
// code and see what it is and its current balance/status, including expired/used.
// Body: { key, code }
import { getStore } from "@netlify/blobs";
import { squareApiBase, SQUARE_VERSION } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const code = (b.code || "").toString().trim().toUpperCase().replace(/\s+/g, "");   // spaces only — pass codes legitimately contain a dash, e.g. "AR4655-1"
  if (!code) return json({ error: "Enter a code." }, 400);
  const today = new Date().toISOString().slice(0, 10);

  // 1) Punch card?
  let pass = null;
  try { pass = await getStore("passes").get("pass:" + code, { type: "json" }); } catch {}
  if (pass) {
    const expired = pass.expiry && pass.expiry < today;
    // Legacy cards carry no `active` field; only an explicit false is deactivated.
    const status = pass.active === false ? "Deactivated" : expired ? "Expired" : (pass.visitsRemaining < 1 ? "No visits left" : "Active");
    return json({
      ok: true, kind: "pass", code, status,
      label: pass.label || "", admission: pass.admission || "",
      visitsRemaining: pass.visitsRemaining || 0, totalVisits: pass.visits || 0,
      expiry: pass.expiry || null, childName: pass.childName || "",
      buyerName: pass.buyerName || "", buyerEmail: pass.buyerEmail || "",
    });
  }

  // 2) Store credit?
  let credit = null;
  try { credit = await getStore("credits").get("credit:" + code, { type: "json" }); } catch {}
  if (credit) {
    const expired = credit.expiry && credit.expiry < today;
    const status = credit.active === false ? "Used / inactive" : expired ? "Expired" : (credit.amount < 1 ? "Used up" : "Active");
    return json({
      ok: true, kind: "credit", code, status,
      creditType: credit.type || "standard",
      balance: credit.amount || 0, original: credit.original || credit.amount || 0,
      expiry: credit.expiry || null, reason: credit.reason || "",
      history: Array.isArray(credit.history) ? credit.history.slice(-8) : [],
    });
  }

  // 3) Discount code?
  let disc = null;
  try { disc = await getStore("discounts").get("disc:" + code, { type: "json" }); } catch {}
  if (disc) {
    const expired = disc.expiry && disc.expiry < today;
    const status = (disc.active === false) ? "Deactivated" : disc.used ? "Used" : expired ? "Expired" : "Active";
    return json({
      ok: true, kind: "discount", code, status,
      percent: disc.percent || 0,
      label: disc.label || "", name: disc.name || "", email: disc.email || "",
      expiry: disc.expiry || null,
      usedAt: disc.usedAt || null, usedBy: disc.usedBy || "",
    });
  }

  // 4) Gift card (Square)?
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (token) {
    try {
      const res = await fetch(`${squareApiBase()}/v2/gift-cards/from-gan`, {
        method: "POST",
        headers: { "Square-Version": SQUARE_VERSION, "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ gan: code.replace(/[^A-Z0-9]/g, "") }),
      });
      const data = await res.json();
      if (res.ok && data.gift_card) {
        const gc = data.gift_card;
        return json({
          ok: true, kind: "giftcard", code,
          status: gc.state === "ACTIVE" ? "Active" : gc.state,
          balance: gc.balance_money?.amount || 0,
        });
      }
    } catch {}
  }

  return json({ ok: false, error: "No pass, store credit, or gift card found for that code." }, 404);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/code-lookup" };
