// POST /api/headcount  (admin key or staff PIN)
//   { key, action:"list" }                          -> today + upcoming parties with caps & saved counts
//   { key, action:"set", date, partySlot, kids, adults } -> save head count, returns overage + charge
import { getStore } from "@netlify/blobs";
import { SIGNATURE_HTML } from "./lib-email.js";
import { slotKey, PARTY_PACKAGES } from "./lib-settings.js";
const ADDITIONAL_CHILD_PRICE = 2500, ADDITIONAL_ADULT_PRICE = 1500;  // inlined so the build never depends on a stale _settings.js

const PARTY_INFO = {
  sweet: {
    guests: "Up to 18 guests \u00b7 10 children total (birthday child + 9 friends)",
    includes: ["Tables & chairs setup", "Choice of black or white tablecloth", "Plates, napkins & plastic utensils", "Juice for the kids & water bottles for everyone", "Simple balloon setup by the birthday child's table", "Birthday banner on the TV", "2-hour private party \u00b7 staff onsite \u00b7 after-party cleanup included"],
    food: "You're welcome to bring outside food, cake, and cupcakes \u2014 please note food must stay in the lobby/seating area only.",
  },
  haven: {
    guests: "Up to 20 guests \u00b7 13 children total (birthday child + 12 friends)",
    includes: ["Tables & chairs setup", "Choice of black or white tablecloth", "Plates, napkins & plastic utensils", "Juice for the kids & water bottles for everyone", "Wall arch backdrop + themed balloon setup", "Happy Birthday banner + banner on the TV", "Ice chest with ice", "Bubble time", "2 large 1-topping pizzas from Tost Pizza (cheese or pepperoni)", "2-hour private party \u00b7 staff onsite \u00b7 after-party cleanup included"],
    food: "Families are welcome to bring additional food, cake, cupcakes, or desserts.",
  },
  dream: {
    guests: "Up to 25 guests \u00b7 15 children total (birthday child + 14 friends)",
    includes: ["Tables & chairs setup", "Choice of black or white tablecloth", "Plates, napkins & plastic utensils", "Juice for the kids & water bottles for everyone", "Wall arch backdrop + balloon garland + themed balloons", "Extra festive balloon accents + window-panel accents", "Happy Birthday banner + banner on the TV", "Ice chest with ice", "Bubble time", "3 large 1-topping pizzas from Tost Pizza (cheese or pepperoni)", "Mascot appearance of choice (based on availability) + short meet-and-greet & photos", "2-hour private party \u00b7 staff onsite \u00b7 after-party cleanup included"],
    food: "Families are welcome to bring additional food, cake, cupcakes, or desserts.",
  },
};

function overage(pkgId, kids, adults, comp) {
  const p = PARTY_PACKAGES[pkgId] || { kidsIncl: 0, adultsIncl: 0 };
  const kidsOver = Math.max(0, (kids || 0) - p.kidsIncl);
  const adultsOver = Math.max(0, (adults || 0) - p.adultsIncl);
  const charge = comp ? 0 : (kidsOver * ADDITIONAL_CHILD_PRICE + adultsOver * ADDITIONAL_ADULT_PRICE);
  return { kidsIncl: p.kidsIncl, adultsIncl: p.adultsIncl, kidsOver, adultsOver, charge, comp: !!comp };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "", provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("parties");
  const action = (b.action || "list").toString();

  if (action === "set") {
    const date = (b.date || "").toString(), partySlot = (b.partySlot || "").toString();
    const kids = Math.max(0, parseInt(b.kids, 10) || 0), adults = Math.max(0, parseInt(b.adults, 10) || 0);
    const k = slotKey(date, partySlot);
    let rec = null; try { rec = await store.get(k, { type: "json" }); } catch {}
    if (!rec) return json({ error: "Party not found." }, 404);
    rec.headKids = kids; rec.headAdults = adults; rec.headAt = new Date().toISOString();
    if (b.comp !== undefined) rec.comp = !!b.comp;
    if (b.deposit !== undefined) rec.depositPaid = Math.max(0, Math.round(parseFloat(b.deposit) * 100) || 0);
    if (b.prefs !== undefined && b.prefs) rec.prefs = {
      theme:  (b.prefs.theme  || "").toString().slice(0, 200),
      colors: (b.prefs.colors || "").toString().slice(0, 300),
      food:   (b.prefs.food   || "").toString().slice(0, 300),
    };
    if (b.notes !== undefined) rec.staffNotes = (b.notes || "").toString().slice(0, 3000);
    try { await store.setJSON(k, rec); } catch { return json({ error: "Couldn't save." }, 502); }
    return json({ ok: true, ...overage(rec.package, kids, adults, rec.comp) });
  }

  // Send the "your party is confirmed" email with preferences + deposit (manual — only when staff click).
  if (action === "confirm-email") {
    const date = (b.date || "").toString(), partySlot = (b.partySlot || "").toString();
    const k = slotKey(date, partySlot);
    let rec = null; try { rec = await store.get(k, { type: "json" }); } catch {}
    if (!rec) return json({ error: "Party not found." }, 404);
    if (!rec.email) return json({ error: "No customer email is on file for this party." }, 400);
    const apiKey = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM || "onboarding@resend.dev", studioEmail = process.env.STUDIO_EMAIL;
    if (!apiKey) return json({ error: "Email isn't configured." }, 500);
    const studio = "Little Haven Play Studio";
    const esc = s => (s || "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const money = c => "$" + ((c || 0) / 100).toFixed(2);
    const pkg = PARTY_PACKAGES[rec.package] || {};
    const pr = rec.prefs || {};
    const prefRows = [
      pr.theme ? `<tr><td style="padding:4px 0;color:#5c6470;width:130px">Theme</td><td style="padding:4px 0;font-weight:bold">${esc(pr.theme)}</td></tr>` : "",
      pr.colors ? `<tr><td style="padding:4px 0;color:#5c6470">Colors</td><td style="padding:4px 0;font-weight:bold">${esc(pr.colors)}</td></tr>` : "",
      pr.food ? `<tr><td style="padding:4px 0;color:#5c6470">Food</td><td style="padding:4px 0;font-weight:bold">${esc(pr.food)}</td></tr>` : "",
    ].join("");
    const info = PARTY_INFO[rec.package] || null;
    const includesBlock = info ? `
      <div style="margin-top:16px">
        <div style="font-weight:bold;color:#a85f59;font-size:15px;margin-bottom:2px">\u{1F381} What's included in your ${esc(rec.packageLabel || "party")}</div>
        <div style="font-size:13px;color:#5c6470;margin-bottom:6px">${esc(info.guests)}</div>
        <ul style="margin:0;padding-left:18px;font-size:14px">${info.includes.map(i => `<li style="margin:3px 0">${esc(i)}</li>`).join("")}</ul>
      </div>
      <div style="margin-top:14px;background:#eaf4e4;border:1px solid #cfe6c2;border-radius:10px;padding:11px 13px">
        <b style="color:#4d6b3e">\u{1F370} What you can bring</b>
        <p style="margin:5px 0 0;font-size:14px;color:#3f5a34">${esc(info.food)}</p>
      </div>` : "";
    const html = `<div style="font-family:Arial,sans-serif;color:#2a2622;line-height:1.6;max-width:560px">
      <h2 style="color:#a85f59;font-weight:normal">Your party is confirmed! 🎉</h2>
      <p>Hi ${esc(rec.name || "there")}, we're so excited to celebrate ${esc(rec.childName || "your little one")} with you! Here are your confirmed details:</p>
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        <tr><td style="padding:4px 0;color:#5c6470;width:130px">Date</td><td style="padding:4px 0;font-weight:bold">${esc(rec.slotLabel || (date + " · " + partySlot))}</td></tr>
        <tr><td style="padding:4px 0;color:#5c6470">Package</td><td style="padding:4px 0;font-weight:bold">${esc(rec.packageLabel || rec.package || "")}</td></tr>
        ${prefRows}
        <tr><td style="padding:4px 0;color:#5c6470">Deposit paid</td><td style="padding:4px 0;font-weight:bold">${money(rec.depositPaid)}</td></tr>
      </table>
      <p style="margin-top:12px;background:#fcfaf6;border:1px solid #efe7da;border-radius:10px;padding:11px 13px;font-size:14px">Any remaining balance is due on the day of the party. We can't wait to celebrate with you!</p>
      ${includesBlock}
      <p style="color:#5c6470;font-size:13px">Questions or changes? Just reply to this email or message @littlehavenplay. — ${studio}</p></div>`;
    try {
      const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${studio} <${from}>`, to: [rec.email], bcc: studioEmail ? [studioEmail] : undefined,
          subject: `Your party is confirmed — ${esc(rec.childName || "Little Haven")}! 🎈`, html: html + SIGNATURE_HTML }) });
      if (!res.ok) return json({ error: "Email failed to send. Try again." }, 502);
    } catch { return json({ error: "Email failed to send. Try again." }, 502); }
    rec.confirmSentAt = new Date().toISOString();
    try { await store.setJSON(k, rec); } catch {}
    return json({ ok: true, sentTo: rec.email });
  }

  // list
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  let keys = [];
  try { const r = await store.list(); keys = (r.blobs || []).map(x => x.key); } catch {}
  const parties = [];
  for (const key of keys) {
    try {
      const r = await store.get(key, { type: "json" });
      if (!r || !r.date || !r.partySlot || r.date < today) continue;
      const p = PARTY_PACKAGES[r.package] || {};
      parties.push({
        date: r.date, partySlot: r.partySlot, slotLabel: r.slotLabel || "",
        package: r.package, packageLabel: r.packageLabel || r.package || "",
        childName: r.childName || "", name: r.name || "", email: r.email || "",
        packageDeposit: p.deposit || 0, slotLabelFull: r.slotLabel || "",
        comp: !!r.comp, depositPaid: r.depositPaid || 0,
        prefs: r.prefs || { theme: "", colors: "", food: "" }, staffNotes: r.staffNotes || "",
        confirmSentAt: r.confirmSentAt || null,
        kidsIncl: p.kidsIncl || 0, adultsIncl: p.adultsIncl || 0,
        headKids: r.headKids || 0, headAdults: r.headAdults || 0,
      });
    } catch {}
  }
  parties.sort((a, c) => (a.date + a.partySlot).localeCompare(c.date + c.partySlot));
  return json({ ok: true, parties, addChild: ADDITIONAL_CHILD_PRICE, addAdult: ADDITIONAL_ADULT_PRICE });
};
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
export const config = { path: "/api/headcount" };
