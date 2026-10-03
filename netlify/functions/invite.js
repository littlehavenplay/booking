// POST /api/invite — party invitations and RSVPs.
//
// Guests (invitation id only):
//   { action:"rsvp", i, rsvpId?, editKey?, attending, name, phone, email, kids:[names], adults, note, smsOptIn }
//
// Host (invitation id + private token from their link):
//   { action:"host-get",  i, t }                       -> party, design, RSVPs, totals
//   { action:"host-save", i, t, theme, headline, message, age, rsvpBy }
//   { action:"host-photo", i, t, dataUrl }             -> upload (dataUrl "") to remove
//   { action:"host-email", i, t, emails }              -> we email the invitation for them
//   { action:"host-remove-rsvp", i, t, rsvpId }
//
// Staff (admin key or staff PIN):
//   { action:"staff-get", key, date, partySlot }       -> links + RSVP list (creates links if needed)
//   { action:"staff-send-host", key, date, partySlot } -> emails the host their invitation link
import { slotKey, STUDIO_NAME } from "./lib-settings.js";
import { resendEmail, fromHeader, signatureFor, TERMS } from "./lib-email.js";
import {
  THEMES, THEME_IDS, ensureInvite, loadByInvite, listRsvps, rsvpTotals, packageCounts,
  hostUrl, guestUrl, photoUrl, defaultHeadline, prettyDate, prettyTime, firstName, randId,
  invitesStore, partiesStore, guestInviteEmail, hostInviteBlockHtml, esc,
} from "./lib-invite.js";
import { subscribe, normPhone, CONSENT_TEXT } from "./lib-sms.js";

const MAX_RSVPS = 150, MAX_EMAILS_TOTAL = 150, MAX_PHOTO_CHARS = 3_000_000;
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const cleanMsg = (v, n) => String(v == null ? "" : v).replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, n);
const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");
const from = () => fromHeader(process.env.EMAIL_FROM || "onboarding@resend.dev", STUDIO_NAME);

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = String(b.action || "");

  // ---------------- Staff ----------------
  if (action.startsWith("staff-")) {
    const provided = String(b.key || "");
    const ok = (process.env.ADMIN_KEY && provided === process.env.ADMIN_KEY) || (process.env.STAFF_PIN && provided === process.env.STAFF_PIN);
    if (!ok) return json({ error: "Wrong key." }, 401);
    const key = slotKey(String(b.date || ""), String(b.partySlot || ""));
    let rec = null; try { rec = await partiesStore().get(key, { type: "json" }); } catch {}
    if (!rec) return json({ error: "Party not found." }, 404);
    rec = await ensureInvite(key, rec);
    const inv = rec.invite;
    if (action === "staff-send-host") {
      if (!okEmail(rec.email)) return json({ error: "This party has no email on file." }, 400);
      const sent = await resendEmail({
        from: from(), to: [rec.email],
        subject: `Your party invitation for ${firstName(rec.childName) || "the birthday child"} 🎈`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;line-height:1.6;max-width:560px;margin:0 auto">
          <h2 style="color:#a85f59;font-weight:normal;margin:0 0 6px">Invite your guests 🎈</h2>
          <p style="margin:0;color:#5c6470">Hi ${esc(firstName(rec.name) || "there")}, here's the link to make the invitation for ${esc(rec.childName || "your party")} on ${esc(prettyDate(rec.date))}.</p>
          ${hostInviteBlockHtml(inv)}
        </div>` + signatureFor(TERMS.parties),
      }, { idempotencyKey: "invite-host:" + inv.id + ":" + new Date().toISOString().slice(0, 13) });
      if (sent) { rec.invite.hostEmailedAt = new Date().toISOString(); try { await partiesStore().setJSON(key, rec); } catch {} }
      return json({ ok: !!sent, message: sent ? "Invitation link emailed to " + rec.email + "." : "Couldn't send the email. Try again." });
    }
    const rsvps = await listRsvps(inv.id);
    return json({ ok: true, hostUrl: hostUrl(inv), guestUrl: guestUrl(inv), hostEmailedAt: inv.hostEmailedAt || "",
      rsvps: rsvps.map(publicRsvp), totals: rsvpTotals(rsvps), pkg: packageCounts(rec),
      childName: rec.childName || "", date: rec.date, slotLabel: rec.slotLabel || "" });
  }

  // Everything below works from an invitation id.
  const id = String(b.i || "").toLowerCase();
  const found = await loadByInvite(id);
  if (!found) return json({ error: "This invitation link isn't valid anymore. Please check with the party host." }, 404);
  const { key } = found; let rec = found.rec; const inv = rec.invite;

  // ---------------- Guests ----------------
  if (action === "rsvp") {
    if (clean(b.website, 50)) return json({ ok: true });            // bot trap
    const attending = b.attending === "no" ? "no" : "yes";
    const name = clean(b.name, 80);
    const phone = clean(b.phone, 30), email = clean(b.email, 160).toLowerCase();
    const kids = (Array.isArray(b.kids) ? b.kids : []).map(k => clean(k, 60)).filter(Boolean).slice(0, 10);
    const adults = Math.max(0, Math.min(10, parseInt(b.adults, 10) || 0));
    if (!name) return json({ error: "Please enter your name." }, 400);
    if (!normPhone(phone) && !okEmail(email)) return json({ error: "Please add a mobile number or an email so the host can reach you." }, 400);
    if (email && !okEmail(email)) return json({ error: "That email doesn't look right." }, 400);
    if (attending === "yes" && !kids.length) return json({ error: "Please add the name of each child coming." }, 400);

    const st = invitesStore();
    let rsvpId = String(b.rsvpId || ""), prev = null;
    if (/^[a-z0-9]{8,16}$/.test(rsvpId)) {
      try { prev = await st.get("rsvp:" + id + ":" + rsvpId, { type: "json" }); } catch {}
      if (prev && prev.editKey !== String(b.editKey || "")) prev = null;
    }
    if (!prev) {
      // Same family answering again from another phone: update their RSVP instead of adding a duplicate.
      const all = await listRsvps(id);
      const p = normPhone(phone);
      prev = all.find(r => (p && normPhone(r.phone) === p) || (email && r.email === email)) || null;
      if (!prev && all.length >= MAX_RSVPS) return json({ error: "This guest list is full. Please contact the host." }, 409);
    }
    const now = new Date().toISOString();
    const rsvp = Object.assign({}, prev || {}, {
      id: prev ? prev.id : randId(12), editKey: prev ? prev.editKey : randId(16),
      attending, name, phone, email, kids: attending === "yes" ? kids : [], adults: attending === "yes" ? adults : 0,
      note: cleanMsg(b.note, 300), at: prev ? prev.at : now, updatedAt: now,
    });
    await st.setJSON("rsvp:" + id + ":" + rsvp.id, rsvp);

    let sms = "";
    if (b.smsOptIn && normPhone(phone)) {
      try { const r = await subscribe({ phone, name, source: "party-invite", consentText: CONSENT_TEXT, reoptin: true }); sms = r.ok ? "subscribed" : ""; } catch {}
    }
    return json({ ok: true, rsvpId: rsvp.id, editKey: rsvp.editKey, updated: !!prev, attending, sms });
  }

  // ---------------- Host ----------------
  if (!action.startsWith("host-")) return json({ error: "Unknown action." }, 400);
  if (!inv.token || String(b.t || "") !== inv.token) return json({ error: "This link isn't valid. Use the link from your party confirmation email." }, 403);

  if (action === "host-get") {
    const rsvps = await listRsvps(id);
    return json({ ok: true,
      party: { childName: rec.childName || "", date: rec.date, prettyDate: prettyDate(rec.date), time: prettyTime(rec.slotLabel), status: rec.status || "" },
      pkg: packageCounts(rec),
      design: { theme: inv.theme, headline: inv.headline || "", defaultHeadline: defaultHeadline(rec, inv), message: inv.message || "", age: inv.age || "", rsvpBy: inv.rsvpBy || "", photo: photoUrl(inv) },
      themes: THEME_IDS.map(t => ({ id: t, label: THEMES[t].label, bg: THEMES[t].bg, accent: THEMES[t].accent, ink: THEMES[t].ink })),
      guestUrl: guestUrl(inv), emailedCount: inv.emailedCount || 0, emailLimit: MAX_EMAILS_TOTAL,
      rsvps: rsvps.map(publicRsvp), totals: rsvpTotals(rsvps) });
  }
  if (action === "host-save") {
    const theme = THEMES[b.theme] ? b.theme : inv.theme;
    const ageN = parseInt(b.age, 10);
    const rsvpBy = /^\d{4}-\d{2}-\d{2}$/.test(b.rsvpBy || "") ? b.rsvpBy : "";
    Object.assign(rec.invite, { theme, headline: clean(b.headline, 80), message: cleanMsg(b.message, 400),
      age: ageN > 0 && ageN < 19 ? String(ageN) : "", rsvpBy, updatedAt: new Date().toISOString() });
    try { await partiesStore().setJSON(key, rec); } catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, defaultHeadline: defaultHeadline(rec, rec.invite) });
  }
  if (action === "host-photo") {
    const st = invitesStore();
    const dataUrl = String(b.dataUrl || "");
    if (!dataUrl) {
      try { await st.delete("photo:" + id); } catch {}
      rec.invite.photoV = 0;
    } else {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!m) return json({ error: "Please choose a JPG or PNG photo." }, 400);
      if (dataUrl.length > MAX_PHOTO_CHARS) return json({ error: "That photo is too large. Try a smaller one." }, 413);
      await st.setJSON("photo:" + id, { type: m[1], b64: m[2], at: new Date().toISOString() });
      rec.invite.photoV = Date.now();
    }
    try { await partiesStore().setJSON(key, rec); } catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, photo: photoUrl(rec.invite) });
  }
  if (action === "host-email") {
    const list = (Array.isArray(b.emails) ? b.emails.join(",") : String(b.emails || ""))
      .split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
    const valid = [...new Set(list.filter(okEmail))];
    const bad = list.filter(e => !okEmail(e));
    if (!valid.length) return json({ error: "Enter at least one email address." }, 400);
    const left = MAX_EMAILS_TOTAL - (inv.emailedCount || 0);
    if (left <= 0) return json({ error: "You've reached the email limit for this party. Share the link by text instead." }, 429);
    const batch = valid.slice(0, Math.min(40, left));
    const { subject, html } = guestInviteEmail(rec);
    let sent = 0;
    for (const to of batch) {
      const ok = await resendEmail({ from: from(), to: [to], reply_to: okEmail(rec.email) ? rec.email : undefined, subject, html: html + signatureFor(TERMS.parties) },
        { idempotencyKey: "invite-guest:" + id + ":" + to });
      if (ok) sent++;
    }
    rec.invite.emailedCount = (inv.emailedCount || 0) + sent;
    try { await partiesStore().setJSON(key, rec); } catch {}
    return json({ ok: true, sent, skipped: valid.length - batch.length, invalid: bad.slice(0, 10) });
  }
  if (action === "host-remove-rsvp") {
    const rid = String(b.rsvpId || "");
    if (!/^[a-z0-9]{8,16}$/.test(rid)) return json({ error: "Missing RSVP." }, 400);
    try { await invitesStore().delete("rsvp:" + id + ":" + rid); } catch {}
    return json({ ok: true });
  }
  return json({ error: "Unknown action." }, 400);
};

// What the host and staff see for each RSVP (never the private edit key).
function publicRsvp(r) {
  return { id: r.id, attending: r.attending, name: r.name, phone: r.phone || "", email: r.email || "",
    kids: r.kids || [], adults: r.adults || 0, note: r.note || "", at: r.at, updatedAt: r.updatedAt || r.at };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/invite" };
