import { SIGNATURE_HTML } from "./lib-email.js";
// POST /api/party-inquiry — emails the owner each inquiry + sends the customer a confirmation.
export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const name = (b.name || "").toString().trim().slice(0, 120);
  const email = (b.email || "").toString().trim().slice(0, 160);
  const phone = (b.phone || "").toString().trim().slice(0, 40);
  const pkg = (b.package || "").toString().trim().slice(0, 80);
  const kids = (b.children_attending || "").toString().trim().slice(0, 20);
  const adults = (b.adults_attending || "").toString().trim().slice(0, 20);
  const details = (b.party_details || "").toString().trim().slice(0, 4000);
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Please enter your name and a valid email." }, 400);

  const key = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM || "onboarding@resend.dev", studioEmail = process.env.STUDIO_EMAIL;
  const studio = "Little Haven Play Studio";
  const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

  // Keep a stored copy so an inquiry is never lost, even if email isn't configured.
  try {
    const { getStore } = await import("@netlify/blobs");
    await getStore("inquiries").setJSON("inq:" + new Date().toISOString() + ":" + Math.random().toString(36).slice(2, 7),
      { name, email, phone, package: pkg, children_attending: kids, adults_attending: adults, party_details: details, at: new Date().toISOString() });
  } catch {}

  if (key && studioEmail) {
    const ownerHtml = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6">
      <h2 style="color:#a85f59">New party inquiry 🎈</h2>
      <table style="border-collapse:collapse;font-size:15px">
        <tr><td style="padding:3px 12px 3px 0;color:#5c6470">Name</td><td><b>${esc(name)}</b></td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#5c6470">Phone</td><td>${esc(phone) || "—"}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#5c6470">Email</td><td>${esc(email)}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#5c6470">Package</td><td>${esc(pkg) || "—"}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#5c6470">Estimate</td><td>${esc(kids) || "?"} kids · ${esc(adults) || "?"} adults</td></tr>
      </table>
      <p style="margin-top:12px"><b>Details:</b><br>${esc(details) || "—"}</p></div>`;
    try {
      await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${studio} <${from}>`, to: [studioEmail], reply_to: email || undefined, subject: `New party inquiry — ${name}`, html: ownerHtml + SIGNATURE_HTML }) });
    } catch {}
  }

  if (key) {
    const custHtml = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6;max-width:540px">
      <h2 style="color:#a85f59;font-weight:normal">Thanks for your inquiry! 🎉</h2>
      <p>Hi ${esc(name)}, we got your party inquiry and we'll be in touch soon to help plan ${esc(pkg) ? ("the " + esc(pkg) + " package") : "your celebration"}.</p>
      <p style="color:#5c6470;font-size:14px">Need us sooner? Message @littlehavenplay on Instagram, Facebook or TikTok, or just reply to this email.</p>
      <p style="color:#5c6470;font-size:13px">— ${studio}</p></div>`;
    try {
      await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${studio} <${from}>`, to: [email], bcc: studioEmail ? [studioEmail] : undefined, subject: `We got your party inquiry — ${studio}`, html: custHtml + SIGNATURE_HTML }) });
    } catch {}
  }
  return json({ ok: true });
};
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
export const config = { path: "/api/party-inquiry" };
