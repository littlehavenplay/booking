// POST /api/email-test  (admin key or staff PIN)
//
// Sends one test email and reports back what the email service ACTUALLY said.
//
// Every other send path swallows errors on purpose — a customer's booking must
// never fail because an email didn't go out. That's right for booking and wrong
// for diagnosis: when something breaks you're left guessing between a bad API
// key, an unverified domain, and a wrong from-address. This endpoint exists to
// answer that question in one press, and it is the ONLY place that reports the
// raw error.
//
// Body: { key, to?: "someone@example.com" }

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const apiKey = process.env.RESEND_API_KEY || "";
  const from   = process.env.EMAIL_FROM || "";
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const to     = (b.to || process.env.STUDIO_EMAIL || "").toString().trim();

  // Check the setup before blaming the network.
  const setup = {
    apiKeySet: !!apiKey,
    apiKeyLooksRight: /^re_/.test(apiKey),
    fromSet: !!from,
    from,
    studioEmailSet: !!process.env.STUDIO_EMAIL,
  };
  if (!apiKey) return json({ ok: false, stage: "config", setup,
    message: "RESEND_API_KEY isn't set in Netlify. Nothing can send until it is." });
  if (!from) return json({ ok: false, stage: "config", setup,
    message: "EMAIL_FROM isn't set in Netlify. Nothing can send until it is." });
  if (!to) return json({ ok: false, stage: "config", setup,
    message: "No address to send to. Type one in, or set STUDIO_EMAIL in Netlify." });

  const sentAt = new Date().toISOString();
  let res, bodyText = "";
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${studio} <${from}>`,
        to: [to],
        subject: `Email test — ${studio}`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;line-height:1.6">
          <h2 style="color:#a85f59;font-weight:normal">Email is working ✓</h2>
          <p>This test was sent from your staff tools at ${sentAt}.</p>
          <p style="color:#8a8276;font-size:13px">Sent from: ${from}</p>
        </div>`,
      }),
    });
    bodyText = await res.text();
  } catch (e) {
    return json({ ok: false, stage: "network", setup,
      message: "Couldn't reach the email service: " + ((e && e.message) || "unknown error") });
  }

  if (res.ok) {
    let id = ""; try { id = (JSON.parse(bodyText) || {}).id || ""; } catch {}
    return json({ ok: true, stage: "sent", setup, to, id,
      message: `Sent to ${to}. If it doesn't arrive within a minute or two, check the junk folder — the email service accepted it, so the problem would be delivery rather than sending.` });
  }

  // Translate the common failures into something actionable.
  let hint = "";
  if (res.status === 401 || res.status === 403)
    hint = "The API key was rejected. Generate a fresh key in Resend and update RESEND_API_KEY in Netlify.";
  else if (res.status === 422 && /domain|from/i.test(bodyText))
    hint = `The from-address (${from}) isn't verified in Resend. Check the domain is still verified and its DNS records are intact.`;
  else if (res.status === 429)
    hint = "Rate limited by the email service — wait a minute and try again.";
  else if (res.status >= 500)
    hint = "The email service itself is having trouble. Try again shortly.";

  return json({ ok: false, stage: "rejected", setup, status: res.status,
    detail: bodyText.slice(0, 400), message: hint || "The email service rejected the send." });
};

export const config = { path: "/api/email-test" };
