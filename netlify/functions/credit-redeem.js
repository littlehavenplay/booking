// POST /api/credit-redeem   (admin key or staff PIN)
// In-store redemption / adjustment of a STANDARD store credit (Option A).
// Body: { key, code, amount }   amount = dollars to deduct (e.g. 4 for a $4 snack)
// Courtesy credits are online-only and cannot be redeemed here.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const code = (b.code || "").toString().trim().toUpperCase();
  const dollars = parseFloat(b.amount);
  if (!code) return json({ error: "Enter a credit code." }, 400);
  if (!(dollars > 0)) return json({ error: "Enter an amount greater than 0." }, 400);
  const cents = Math.round(dollars * 100);

  const store = getStore("credits");
  let rec = null;
  try { rec = await store.get("credit:" + code, { type: "json" }); } catch { rec = null; }
  if (!rec) return json({ error: "That credit code wasn't found." }, 404);
  if (rec.type === "courtesy" || rec.channel === "online")
    return json({ error: "This is a courtesy credit — it's valid online for open play only and can't be redeemed in store." }, 400);
  if (!rec.active || (rec.amount || 0) < 1) return json({ error: "That credit has no balance left." }, 400);
  const today = new Date().toISOString().slice(0, 10);
  if (rec.expiry && rec.expiry < today) return json({ error: `That credit expired on ${rec.expiry}.` }, 400);
  if (cents > rec.amount) return json({ error: `Only $${(rec.amount / 100).toFixed(2)} left on this credit.` }, 400);

  rec.amount = Math.max(0, rec.amount - cents);
  if (rec.amount === 0) rec.active = false;
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  rec.history.push({ at: new Date().toISOString(), action: "redeemed-instore", amount: cents, where: "in store" });
  try { await store.setJSON("credit:" + code, rec); }
  catch { return json({ error: "Couldn't update the credit. Try again." }, 502); }

  return json({ ok: true, code, deducted: cents, balance: rec.amount, message: `Deducted $${(cents / 100).toFixed(2)}. $${(rec.amount / 100).toFixed(2)} remaining.` });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/credit-redeem" };
