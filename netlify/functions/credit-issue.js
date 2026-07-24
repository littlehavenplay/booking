// POST /api/credit-issue   (admin key or staff PIN)
// Body: { key, amount, reason, email?, name?, type, expiryDays? }   type = "courtesy" | "standard"
//   courtesy = single-use, online + open-play only, flyer email
//   standard = balance (carries over), redeemable anywhere (online + in store)
// Shares its credit-creation and email logic with reschedule.js's cancel-booking
// flow and noshow-cron.js — see lib-credit.js.
import { makeCredit, sendCreditEmail } from "./lib-credit.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (body.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured. Set ADMIN_KEY in Netlify." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const type = (body.type || "standard").toString() === "courtesy" ? "courtesy" : "standard";
  const dollars = parseFloat(body.amount);
  if (!(dollars > 0)) return json({ error: "Enter a dollar amount greater than 0." }, 400);
  const amount = Math.round(dollars * 100); // cents
  const reason = (body.reason || "").toString().slice(0, 200).trim();
  const custName = (body.name || "").toString().slice(0, 80).trim();

  // Expiry is selectable at issuance (default 30 days). The admin/staff dropdown
  // sends expiryDays: 30 / 60 / 90 / 180 (6 months) / 365 (1 year).
  let expiryDays = parseInt(body.expiryDays, 10);
  if (!Number.isFinite(expiryDays) || expiryDays < 1) {
    expiryDays = parseInt(process.env.CREDIT_EXPIRY_DAYS || "30", 10);
  }
  expiryDays = Math.min(Math.max(expiryDays, 1), 366);

  const record = await makeCredit(type, amount, reason, { custName, expiryDays });
  if (!record) return json({ error: "Couldn't save the credit. Try again." }, 502);

  const custEmail = (body.email || "").toString().slice(0, 160).trim();
  let emailedCustomer = false;
  if (custEmail && /^\S+@\S+\.\S+$/.test(custEmail)) {
    emailedCustomer = await sendCreditEmail(custEmail, record, false);
  }
  const ownerEmail = process.env.STUDIO_EMAIL || "";
  if (ownerEmail) await sendCreditEmail(ownerEmail, record, true);

  return json({ ok: true, code: record.code, amount, expiry: record.expiry, reason, type, emailedCustomer });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/credit-issue" };
