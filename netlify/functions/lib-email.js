// Shared email signature (business card) appended to every outgoing email.
export const SITE = "https://littlehavenplay.com";

// ---- One place for policies ----------------------------------------------
// Policies used to be pasted into the emails themselves, which made a booking
// confirmation several screens long and buried the two things the customer
// actually needed: their reservation details and the waiver button. Everything
// now points at /terms.html, which already renders the live policy text pulled
// from /api/config -- so a policy change updates the page, not fifteen emails.
export const TERMS_URL = `${SITE}/terms.html`;
export const FAQ_URL   = `${SITE}/#faq`;
export const STUDIO_EMAIL_PUBLIC = "hello@littlehavenplay.com";

// Deep links into the individual sections of the terms page, so an email about
// a party or a punch card lands on the part that applies to it.
export const TERMS = {
  all:        TERMS_URL,
  openplay:   `${TERMS_URL}#openplay`,
  parties:    `${TERMS_URL}#parties`,
  playclub:   `${TERMS_URL}#playclub`,
  punchcards: `${TERMS_URL}#punchcards`,
  waiver:     `${TERMS_URL}#waiver`,
  giftcards:  `${TERMS_URL}#giftcards`,
  events:     `${TERMS_URL}#events`,
};

// The small print, and the only small print. Three links on one line.
export function footerHtml(termsUrl) {
  const t = termsUrl || TERMS_URL;
  return `<p style="margin:18px 0 0;padding-top:14px;border-top:1px solid #efe7da;font-size:12px;color:#aea298;line-height:1.8">
  Questions? Email <a href="mailto:${STUDIO_EMAIL_PUBLIC}" style="color:#a85f59;text-decoration:none">${STUDIO_EMAIL_PUBLIC}</a>
  &nbsp;&middot;&nbsp; <a href="${FAQ_URL}" style="color:#a85f59;text-decoration:none">FAQ</a>
  &nbsp;&middot;&nbsp; <a href="${t}" style="color:#a85f59;text-decoration:none">Terms &amp; policies</a>
</p>`;
}

export function footerText(termsUrl) {
  return `\n\nQuestions? ${STUDIO_EMAIL_PUBLIC}\nFAQ: ${FAQ_URL}\nTerms & policies: ${termsUrl || TERMS_URL}`;
}

// A waiver nudge is worth keeping -- a signed waiver before arrival genuinely
// speeds up check-in. It does not need three paragraphs explaining the rules;
// anyone who wants the detail can follow the terms link in the footer, and
// anyone who arrives unsigned simply signs at the door.
export function waiverButtonHtml(url) {
  return `<div style="margin:20px 0;text-align:center">
  <a href="${url}" style="display:inline-block;background:#c97d76;color:#fff;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:.04em;text-transform:uppercase;padding:12px 26px;border-radius:40px">Sign your waiver</a>
</div>`;
}

// Same footer + business card, but pointed at the relevant section of the terms
// page. SIGNATURE_HTML below is just signatureFor() with the default link.
export function signatureFor(termsUrl) {
  return `${footerHtml(termsUrl)}<div style="margin-top:16px">
  <img src="${SITE}/assets/email-signature.png" alt="Little Haven Play Studio · Yucca Valley, CA · littlehavenplay.com · hello@littlehavenplay.com · @littlehavenplay" style="width:100%;max-width:440px;display:block">
</div>`;
}

export const SIGNATURE_HTML = `${footerHtml()}<div style="margin-top:16px">
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
