// Shared birthday-gift helpers, used by /api/birthdays and the daily scheduled sender.
// A birthday gift code reuses the free-visit reward mechanism (one free child admission),
// but is locked to a single day: validFrom === expiry === the birthday. Single-use.
import { getStore } from "@netlify/blobs";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1

// The next time this birthday comes around (today counts).
export function nextOccurrence(dob, todayISO) {
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const mmdd = dob.slice(5);
  const thisYear = today.slice(0, 4);
  const candidate = thisYear + "-" + mmdd;
  return candidate >= today ? candidate : (Number(thisYear) + 1) + "-" + mmdd;
}

export function ageOn(dob, onDate) {
  return Number(onDate.slice(0, 4)) - Number(dob.slice(0, 4));
}

// `when` can be a single "YYYY-MM-DD" string (the existing automatic birthday
// flow — validFrom and expiry both land on that one day, unchanged behavior),
// or an object { validFrom, validUntil } for a custom multi-day window (the
// manual staff tool, e.g. covering a birthday that falls on a closed Monday).
export async function issueBirthdayCode(rec, when, loyaltyCode) {
  const isRange = when && typeof when === "object";
  const validFrom = isRange ? when.validFrom : when;
  const validUntil = isRange ? (when.validUntil || when.validFrom) : when;

  const rewards = getStore("rewards");
  let code = "";
  for (let i = 0; i < 10; i++) {
    let s = "BDAY";
    for (let j = 0; j < 4; j++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    let exists = null; try { exists = await rewards.get("reward:" + s, { type: "json" }); } catch {}
    if (!exists) { code = s; break; }
  }
  if (!code) code = "BDAY" + Date.now().toString(36).toUpperCase().slice(-5);

  try {
    await rewards.setJSON("reward:" + code, {
      code, type: "free-visit", kind: "birthday", source: "birthday",
      childName: ((rec.first || "") + " " + (rec.last || "")).trim(),
      loyaltyCode: loyaltyCode || rec.code || null,
      validFrom, expiry: validUntil, used: false,
      issuedAt: new Date().toISOString(),
    });
  } catch { return { ok: false, error: "Couldn't save the gift code. Try again." }; }

  // Mirror the code onto the loyalty card itself, so the booking page (and admin)
  // can surface "it's their birthday!" just by looking up the loyalty code.
  const lc = loyaltyCode || rec.code || null;
  if (lc) {
    try {
      const loyalty = getStore("loyalty");
      const card = await loyalty.get("card:" + lc, { type: "json" });
      if (card) {
        card.activeBirthdayCode = code;
        card.activeBirthdayExpiry = validUntil;
        await loyalty.setJSON("card:" + lc, card);
      }
    } catch {}
  }

  let emailed = false;
  try { emailed = await sendBirthdayEmail(rec, code, isRange ? { validFrom, validUntil } : when); } catch {}
  return { ok: true, code, emailed, validFrom, validUntil };
}

export async function sendBirthdayEmail(rec, code, when) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !rec.email) return false;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const name = esc(rec.first || "your little one");
  const isRange = when && typeof when === "object" && when.validFrom !== when.validUntil;
  const singleDay = isRange ? when.validFrom : when;
  const pretty = prettyDate(singleDay);
  const turning = ageOn(rec.dob, singleDay);
  const validityLine = isRange
    ? `Good between <b>${esc(prettyDate(when.validFrom))}</b> and <b>${esc(prettyDate(when.validUntil))}</b> 🎈`
    : `Good on ${esc(pretty)} — birthday day only 🎈`;
  const bodyLine = isRange
    ? `Enter this code in the <b>"Free-visit reward code"</b> box when you book online. It's valid for one child admission any day between <b>${esc(prettyDate(when.validFrom))}</b> and <b>${esc(prettyDate(when.validUntil))}</b>, and can be used once.`
    : `Enter this code in the <b>"Free-visit reward code"</b> box when you book online. It's valid on ${esc(pretty)} only, for one child admission, and can be used once.`;

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;background:#fdf1ec;padding:26px 14px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#c97d76,#e0a89f);padding:26px 24px;text-align:center">
      <div style="font-size:40px;line-height:1">🎂🎈🎉</div>
      <h1 style="margin:8px 0 0;color:#ffffff;font-size:26px;font-weight:800;letter-spacing:.3px">Happy Birthday, ${name}!</h1>
      ${turning > 0 && turning < 19 ? `<p style="margin:6px 0 0;color:#ffeae6;font-size:15px;font-weight:700">Turning ${turning}! 🌟</p>` : ""}
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 14px;font-size:15px;color:#2a2622;line-height:1.6">
        We can't wait to celebrate with you! Here's a little gift from all of us at ${esc(studio)} —
        <b>one FREE admission</b> for ${name}.
      </p>
      <div style="background:#ecf1e8;border:2px dashed #7ba676;border-radius:16px;padding:18px;text-align:center;margin:18px 0">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#4d7848;font-weight:800">Your birthday gift code</div>
        <div style="font-size:30px;font-weight:800;letter-spacing:3px;color:#2a2622;margin:8px 0">${esc(code)}</div>
        <div style="font-size:13px;color:#4d7848;font-weight:700">${validityLine}</div>
      </div>
      <p style="margin:0 0 14px;font-size:14px;color:#5c6470;line-height:1.6">
        ${bodyLine}
      </p>
      <div style="text-align:center;margin:22px 0 6px">
        <a href="https://littlehavenplay.com/book.html" style="display:inline-block;background:#c97d76;color:#ffffff;text-decoration:none;font-weight:800;font-size:16px;padding:14px 34px;border-radius:40px">Book the birthday visit →</a>
      </div>
      <p style="margin:16px 0 0;font-size:13px;color:#aea298;text-align:center">See you soon — ${esc(studio)} 💛</p>
    </div>
  </div>
</div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${studio} <${from}>`, to: [rec.email], bcc: bcc ? [bcc] : undefined,
      subject: `🎂 Happy Birthday ${rec.first}! A free visit is waiting`, html,
    }),
  });
  return res.ok;
}

export async function sendBirthdayDayOfEmail(rec, code, when) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !rec.email) return false;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const bcc = process.env.STUDIO_EMAIL || undefined;
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const name = esc(rec.first || "your little one");

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;background:#fdf1ec;padding:26px 14px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#c97d76,#e0a89f);padding:26px 24px;text-align:center">
      <div style="font-size:40px;line-height:1">🎉🎂🎉</div>
      <h1 style="margin:8px 0 0;color:#ffffff;font-size:26px;font-weight:800;letter-spacing:.3px">It's ${name}'s birthday today!</h1>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 14px;font-size:15px;color:#2a2622;line-height:1.6">
        Just a reminder — today's the day! Your free admission code is still waiting:
      </p>
      <div style="background:#ecf1e8;border:2px dashed #7ba676;border-radius:16px;padding:18px;text-align:center;margin:18px 0">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#4d7848;font-weight:800">Your birthday gift code</div>
        <div style="font-size:30px;font-weight:800;letter-spacing:3px;color:#2a2622;margin:8px 0">${esc(code)}</div>
        <div style="font-size:13px;color:#4d7848;font-weight:700">Good today only 🎈</div>
      </div>
      <div style="text-align:center;margin:22px 0 6px">
        <a href="https://littlehavenplay.com/book.html" style="display:inline-block;background:#c97d76;color:#ffffff;text-decoration:none;font-weight:800;font-size:16px;padding:14px 34px;border-radius:40px">Book today's visit →</a>
      </div>
      <p style="margin:16px 0 0;font-size:13px;color:#aea298;text-align:center">Happy birthday from all of us — ${esc(studio)} 💛</p>
    </div>
  </div>
</div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${studio} <${from}>`, to: [rec.email], bcc: bcc ? [bcc] : undefined,
      subject: `🎉 Happy Birthday ${rec.first}! Today's the day`, html,
    }),
  });
  return res.ok;
}

export function prettyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${months[m - 1]} ${d}, ${y}`;
}
export function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
