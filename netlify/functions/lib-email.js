// Shared email signature (business card) appended to every outgoing email.
export const SITE = "https://littlehavenplay.com";
export const SIGNATURE_HTML = `<div style="margin-top:24px;border-top:1px solid #eee4d6;padding-top:16px">
  <img src="${SITE}/assets/email-signature.png" alt="Little Haven Play Studio · Yucca Valley, CA · littlehavenplay.com · hello@littlehavenplay.com · @littlehavenplay" style="width:100%;max-width:440px;display:block">
</div>`;

// General-purpose "notify the studio owner" email — used for anything that needs
// a real-time heads-up (e.g. a code that failed to redeem at checkout). Silently
// no-ops if STUDIO_EMAIL or RESEND_API_KEY aren't configured, so it never blocks
// the request that triggered it.
export async function sendOwnerAlert(subject, bodyHtml) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.STUDIO_EMAIL;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  if (!key || !to) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${studio} Alerts <${from}>`, to: [to], subject,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;line-height:1.6">${bodyHtml}</div>${SIGNATURE_HTML}` }),
    });
    return res.ok;
  } catch { return false; }
}
