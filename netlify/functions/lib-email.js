// Shared email signature (business card) appended to every outgoing email.
export const SITE = "https://littlehavenplay.com";
export const SIGNATURE_HTML = `<div style="margin-top:24px;border-top:1px solid #eee4d6;padding-top:16px">
  <img src="${SITE}/assets/email-signature.png" alt="Little Haven Play Studio · Yucca Valley, CA · littlehavenplay.com · hello@littlehavenplay.com · @littlehavenplay" style="width:100%;max-width:440px;display:block">
</div>`;

// General-purpose "notify the studio owner" email — used for anything that needs
// a real-time heads-up (e.g. a code that failed to redeem at checkout). Silently
// no-ops if STUDIO_EMAIL or RESEND_API_KEY aren't configured, so it never blocks
// the request that triggered it.
// extraTo: an additional recipient for this one alert (used by the family-code
// tripwire so it can reach a personal inbox as well as the studio address).
// Build a valid RFC-5322 From header.
//
// Env vars sometimes hold a bare address ("hello@x.com") and sometimes a full
// display-name form ("Studio <hello@x.com>"). Blindly wrapping the second kind
// produces "Studio <Studio <hello@x.com>>", which Resend rejects with a 422 —
// and because batch sends only checked res.ok, that failed silently and retried
// forever. Use this everywhere instead of interpolating by hand.
export function fromHeader(addr, studioName) {
  const a = (addr || "").toString().trim();
  if (!a) return `${studioName || "Little Haven Play Studio"} <onboarding@resend.dev>`;
  if (a.indexOf("<") > -1 && a.indexOf(">") > -1) return a;   // already has a display name
  return `${studioName || "Little Haven Play Studio"} <${a}>`;
}

export async function sendOwnerAlert(subject, bodyHtml, extraTo) {
  const key = process.env.RESEND_API_KEY;
  const base = process.env.STUDIO_EMAIL;
  const to = extraTo && extraTo !== base ? [base, extraTo].filter(Boolean) : base;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  if (!key || !to) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${studio} Alerts <${from}>`, to: Array.isArray(to) ? to : [to], subject,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;line-height:1.6">${bodyHtml}</div>${SIGNATURE_HTML}` }),
    });
    return res.ok;
  } catch { return false; }
}

// Reliable Resend sender for transactional emails (confirmations, registrations).
// POSTs the email and, if it fails with a rate-limit (429) or server error (5xx) or a
// network hiccup, waits briefly and retries ONCE. This keeps confirmations from being
// dropped or delayed during bursts of activity. Returns true on success; never throws.
export async function resendEmail(payload) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body,
      });
      if (res.ok) return true;
      if (attempt === 0 && (res.status === 429 || res.status >= 500)) { await new Promise(r => setTimeout(r, 700)); continue; }
      return false;
    } catch {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 700)); continue; }
      return false;
    }
  }
  return false;
}
