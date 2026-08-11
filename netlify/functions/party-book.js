// POST /api/party-book
// Public: reserve a party slot (status pending-deposit) and get the Square deposit link.
// Staff (with valid staffPin): record an in-store party (status confirmed-instore),
//   skipping the 3-week rule. Either way the slot is held so open play can't take it.
//
// Body: { date, partySlot, package, childName, name, phone, email, kids, adults, comment, agree, staffPin? }

import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import {
  PARTY_SLOTS, PARTY_SLOT_IDS, PARTY_PACKAGES, isPartyDay,
  PARTY_BOOKING_MIN_DAYS, slotKey, STUDIO_NAME, WAIVER_URL,
  loadPartyOff, isPartyOff,
} from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const date = (b.date || "").trim();
  const partySlot = (b.partySlot || "").trim();
  const pkgId = (b.package || "").trim().toLowerCase();
  const childName = (b.childName || "").toString().slice(0, 80).trim();
  const name = (b.name || "").toString().slice(0, 120).trim();
  const phone = (b.phone || "").toString().slice(0, 40).trim();
  const email = (b.email || "").toString().slice(0, 160).trim();
  const kids = (b.kids || "").toString().slice(0, 20).trim();
  const adults = (b.adults || "").toString().slice(0, 20).trim();
  const comment = (b.comment || "").toString().slice(0, 1500).trim();
  const agree = !!b.agree;
  const wholeDay = !!b.wholeDay;   // staff option: close the entire date to other bookings

  // Staff override?
  const staffPin = (b.staffPin || "").toString();
  const isStaff = !!staffPin && (staffPin === process.env.STAFF_PIN || staffPin === process.env.ADMIN_KEY);

  // Validation
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a valid date." }, 400);
  if (!isPartyDay(date))                 return json({ error: "Parties are available Friday, Saturday and Sunday only." }, 400);
  if (isPartyOff(date, await loadPartyOff())) return json({ error: "Parties are turned off for this date — it's open play only. No party bookings or deposits are being accepted that day.", partiesOff: true }, 400);
  if (!PARTY_SLOT_IDS.includes(partySlot)) return json({ error: "Pick a valid party time." }, 400);
  const pkg = PARTY_PACKAGES[pkgId];
  if (!pkg)                              return json({ error: "Pick a party package." }, 400);
  if (!childName)                        return json({ error: "Please enter the birthday child's name." }, 400);
  if (!name)                             return json({ error: "Please enter your full name." }, 400);
  if ((phone.replace(/\D/g, "")).length < 7) return json({ error: "Please enter a valid phone number." }, 400);
  if (!/^\S+@\S+\.\S+$/.test(email))     return json({ error: "Please enter a valid email." }, 400);
  if (!agree && !isStaff)                return json({ error: "Please agree to the deposit & cancellation policy." }, 400);
  if (!isStaff) {
    const minStr = new Date(Date.now() + PARTY_BOOKING_MIN_DAYS * 86400000).toISOString().slice(0, 10);
    if (date < minStr) return json({ error: `Parties must be booked at least ${PARTY_BOOKING_MIN_DAYS} days in advance.` }, 400);
  }

  const parties = getStore("parties");
  const key = slotKey(date, partySlot);

  // Slot still free?
  let existing = null;
  try { existing = await parties.get(key, { type: "json" }); } catch { existing = null; }
  if (existing) return json({ error: "taken", message: "Sorry, that party time was just reserved. Please choose another." }, 409);

  const slotLabel = (PARTY_SLOTS.find(s => s.id === partySlot) || {}).label || partySlot;
  const record = {
    status: isStaff ? "confirmed-instore" : "pending-deposit",
    date, partySlot, slotLabel,
    package: pkgId, packageLabel: pkg.label, deposit: pkg.deposit,
    childName, name, phone, email, kids, adults, comment,
    at: new Date().toISOString(),
  };
  try { await parties.setJSON(key, record); }
  catch { return json({ error: "Couldn't save the reservation. Please try again." }, 502); }

  // Staff chose to reserve the entire date: add a full-day closure so no open play or other
  // parties can be booked. Shows "Closed for a private party" publicly.
  if (isStaff && wholeDay) {
    try {
      const site = getStore("site");
      const closures = (await site.get("closures", { type: "json" })) || {};
      closures[date] = { type: "full", note: "Closed for a private party", at: new Date().toISOString() };
      await site.setJSON("closures", closures);
    } catch {}
  }

  await emailStudio(record);
  await emailCustomer(record, isStaff ? null : pkg.link);

  return json({
    ok: true,
    status: record.status,
    depositLink: isStaff ? null : pkg.link,
    deposit: pkg.deposit,
    message: isStaff
      ? ("Party recorded and the slot is held." + (wholeDay ? " The whole day is now closed to other bookings." : "") + " Collect the deposit on your Square terminal.")
      : "Your party request is saved! Pay the deposit at the next step to confirm your reservation.",
  });
};

async function emailStudio(r) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.STUDIO_EMAIL || process.env.EMAIL_FROM;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  if (!key || !to) return;
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const money = c => "$" + (c / 100).toFixed(2);
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal">${r.status === "confirmed-instore" ? "In-store party recorded 🎉" : "New party request 🎈"}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <tr><td style="padding:5px 0;color:#5c6470;width:150px">Status</td><td style="padding:5px 0;font-weight:bold">${r.status}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Package</td><td style="padding:5px 0;font-weight:bold">${esc(r.packageLabel)} (deposit ${money(r.deposit)})</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Date</td><td style="padding:5px 0;font-weight:bold">${esc(r.date)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Time</td><td style="padding:5px 0;font-weight:bold">${esc(r.slotLabel)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Birthday child</td><td style="padding:5px 0;font-weight:bold">${esc(r.childName)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Booked by</td><td style="padding:5px 0;font-weight:bold">${esc(r.name)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Phone</td><td style="padding:5px 0;font-weight:bold">${esc(r.phone)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Email</td><td style="padding:5px 0;font-weight:bold">${esc(r.email)}</td></tr>
      <tr><td style="padding:5px 0;color:#5c6470">Guests (est.)</td><td style="padding:5px 0;font-weight:bold">${esc(r.kids) || "—"} kids · ${esc(r.adults) || "—"} adults</td></tr>
    </table>
    <div style="margin-top:14px;background:#fcfaf6;border:1px solid #efe7da;border-radius:12px;padding:14px">
      <div style="color:#5c6470;font-size:13px;margin-bottom:4px">Comment</div>
      <div style="white-space:pre-wrap">${esc(r.comment) || "—"}</div>
    </div>
    <p style="color:#5c6470;font-size:13px;margin-top:14px">${r.status === "pending-deposit" ? "This slot is held pending the deposit. Confirm it in the staff page once the Square deposit is paid, or release it if it isn't." : "Slot is held. Remember to collect the deposit on your Square terminal."}</p>
  </div>`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${STUDIO_NAME} Parties <${from}>`, to: [to], reply_to: r.email || undefined,
        subject: `Party — ${r.date} ${r.slotLabel} — ${r.packageLabel} (${r.childName})`, html: html + SIGNATURE_HTML }),
    });
  } catch {}
}

async function emailCustomer(r, depositLink) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;   // owner gets a copy of the customer email too
  if (!key || !r.email) return;
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const money = c => "$" + (c / 100).toFixed(2);
  const pending = r.status === "pending-deposit";
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:0 auto;line-height:1.6">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 6px">${pending ? "Your party request is saved! 🎈" : "Your party is booked! 🎉"}</h2>
    <p style="margin:0 0 12px;color:#5c6470">Hi ${esc(r.name)}, here are the details for ${esc(r.childName)}'s celebration:</p>
    <div style="background:#fcfaf6;border:1px solid #efe7da;border-radius:12px;padding:16px">
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        <tr><td style="padding:4px 0;color:#5c6470;width:120px">Package</td><td style="padding:4px 0;font-weight:bold">${esc(r.packageLabel)}</td></tr>
        <tr><td style="padding:4px 0;color:#5c6470">Date</td><td style="padding:4px 0;font-weight:bold">${esc(r.date)}</td></tr>
        <tr><td style="padding:4px 0;color:#5c6470">Time</td><td style="padding:4px 0;font-weight:bold">${esc(r.slotLabel)}</td></tr>
        <tr><td style="padding:4px 0;color:#5c6470">Deposit</td><td style="padding:4px 0;font-weight:bold">${money(r.deposit)}</td></tr>
      </table>
    </div>
    ${pending && depositLink
      ? `<p style="margin:16px 0"><a href="${depositLink}" style="display:inline-block;background:#c97d76;color:#fff;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:12px">Pay your deposit to confirm →</a></p><p style="color:#5c6470;font-size:13px">Your time is held, but it isn't confirmed until the deposit is paid.</p>`
      : `<p style="color:#5f7d52;font-weight:bold;margin:16px 0">Your reservation is confirmed — we can't wait to celebrate! 🎂</p>`}
    <div style="background:#f3f0ff;border-radius:12px;padding:14px 16px;margin:14px 0">
      <p style="margin:0 0 6px;font-weight:bold;color:#5b4636">📋 Don't forget the waiver!</p>
      <p style="margin:0 0 10px;color:#5c6470;font-size:14px">Every guest must sign before arrival to avoid delays at your party. Please forward this link to all your guests, or have them sign at littlehavenplay.com:</p>
      <a href="${WAIVER_URL}" style="display:inline-block;background:#7a6253;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:10px">Sign the waiver →</a>
    </div>
    <p style="color:#5c6470;font-size:13px;margin-top:14px">Questions? Reply to this email or message us @littlehavenplay. — ${STUDIO_NAME}</p>
  </div>`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${STUDIO_NAME} <${from}>`, to: [r.email], bcc: bcc ? [bcc] : undefined,
        subject: `${pending ? "Party request" : "Party confirmed"} — ${r.childName}'s party on ${r.date}`, html: html + SIGNATURE_HTML }),
    });
  } catch {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/party-book" };
