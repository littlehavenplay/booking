// Party invitations — shared pieces.
//
// Every confirmed party gets two private-ish links:
//   host link   /party-invite.html?i=<id>&t=<token>   the birthday parent designs
//               the invitation, shares it, and watches RSVPs come in
//   guest link  /i/<id>                              the invitation itself: details,
//               Sign-the-waiver button, RSVP form
//
// Data:
//   parties store, on the party record:  invite: { id, token, theme, headline,
//       message, age, rsvpBy, photoV, emailedCount, createdAt, updatedAt }
//   invites store:
//       inv:<id>             -> { key }   (which party this invitation belongs to)
//       rsvp:<id>:<rsvpId>   -> one guest family's RSVP (one key each, so two
//                               families answering at once can't overwrite each other)
//       photo:<id>           -> { type, b64 }  the host's uploaded photo
import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { PARTY_PACKAGES, PARTY_SLOTS, WAIVER_URL } from "./lib-settings.js";

export const SITE = (process.env.SITE_URL || "https://littlehavenplay.com").replace(/\/$/, "");
export const STUDIO = process.env.STUDIO_NAME || "Little Haven Play Studio";
export const STUDIO_ADDRESS = "58080 29 Palms Hwy, Yucca Valley, CA 92284";
export const MAPS_URL = "https://maps.google.com/?q=" + encodeURIComponent("Little Haven Play Studio, " + STUDIO_ADDRESS);
export { WAIVER_URL };

export const partiesStore = () => getStore({ name: "parties", consistency: "strong" });
export const invitesStore = () => getStore({ name: "invites", consistency: "strong" });

// ---- Designs -------------------------------------------------------------
// Original artwork only (no licensed characters). Colors are fixed per design:
// an invitation is a printed-card look, so it doesn't follow dark mode.
export const THEMES = {
  balloons: { label: "Balloon Bash",   bg: "#fdf1ec", card: "#fffaf6", ink: "#4a3526", soft: "#7a6253", accent: "#c97d76", accentInk: "#ffffff", line: "#f0d9d2" },
  confetti: { label: "Confetti Pop",   bg: "#fff7e8", card: "#ffffff", ink: "#3a2f4a", soft: "#6b5f7a", accent: "#e0794f", accentInk: "#ffffff", line: "#f3e3c8" },
  jungle:   { label: "Jungle Safari",  bg: "#eef4e8", card: "#fbfdf8", ink: "#2f4026", soft: "#5a6b4f", accent: "#5f8a5a", accentInk: "#ffffff", line: "#d6e6c8" },
  ocean:    { label: "Under the Sea",  bg: "#e6f3f7", card: "#f9fdff", ink: "#1f4152", soft: "#4f6f80", accent: "#2f8aa8", accentInk: "#ffffff", line: "#cbe5ee" },
  space:    { label: "Outer Space",    bg: "#1d2147", card: "#262b5c", ink: "#f4f1ff", soft: "#c9c4ea", accent: "#f5b84a", accentInk: "#1d2147", line: "#3a4080" },
  rainbow:  { label: "Pastel Rainbow", bg: "#fdf6f9", card: "#ffffff", ink: "#4a3a48", soft: "#7a6878", accent: "#b46aa0", accentInk: "#ffffff", line: "#f1dfe9" },
  sparkle:  { label: "Sparkle & Shine", bg: "#f4effb", card: "#fdfbff", ink: "#3d2f5a", soft: "#6d5f8a", accent: "#8a6cc4", accentInk: "#ffffff", line: "#e3d9f3" },
};
export const THEME_IDS = Object.keys(THEMES);
export const DEFAULT_THEME = "balloons";

// Decorative artwork for the top of each card (inline SVG, 600x150 viewBox).
export function themeArt(id) {
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const B = (cx, cy, r, c) => `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 1.18}" fill="${c}"/><path d="M${cx} ${cy + r * 1.18} q-6 18 4 34 q8 16 -2 40" stroke="${c}" stroke-width="2" fill="none" opacity=".7"/><ellipse cx="${cx - r * .35}" cy="${cy - r * .45}" rx="${r * .18}" ry="${r * .28}" fill="#fff" opacity=".45"/>`;
  const star4 = (x, y, s, c) => `<path d="M${x} ${y - s} Q${x + s * .18} ${y - s * .18} ${x + s} ${y} Q${x + s * .18} ${y + s * .18} ${x} ${y + s} Q${x - s * .18} ${y + s * .18} ${x - s} ${y} Q${x - s * .18} ${y - s * .18} ${x} ${y - s}Z" fill="${c}"/>`;
  const leaf = (x, y, rot, s, c) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})"><path d="M0 0 C 30 -40, 90 -40, 120 0 C 90 40, 30 40, 0 0Z" fill="${c}"/><path d="M4 0 L 112 0" stroke="#ffffff" stroke-opacity=".35" stroke-width="3"/></g>`;
  switch (id) {
    case "confetti": {
      const cs = ["#e0794f", "#f2b84b", "#5fb3a6", "#8a6cc4", "#e86a92", "#6aa7e0"];
      let s = ""; let k = 0;
      for (let i = 0; i < 46; i++) { const x = Math.round(rnd() * 600), y = Math.round(rnd() * 135 + 6), c = cs[k++ % cs.length], r = Math.round(rnd() * 360);
        s += i % 3 ? `<rect x="${x}" y="${y}" width="12" height="6" rx="2" fill="${c}" transform="rotate(${r} ${x + 6} ${y + 3})"/>` : `<circle cx="${x}" cy="${y}" r="5" fill="${c}"/>`; }
      return s;
    }
    case "jungle":
      return leaf(-20, 30, 20, 1.1, "#7ba06c") + leaf(0, 70, -10, .9, "#5f8a5a") + leaf(40, 10, 50, .7, "#9ec089")
        + leaf(620, 30, 160, 1.1, "#7ba06c") + leaf(600, 75, 190, .9, "#5f8a5a") + leaf(560, 10, 130, .7, "#9ec089")
        + `<circle cx="300" cy="40" r="18" fill="#f2c14e" opacity=".85"/>`;
    case "ocean": {
      let s = `<path d="M0 110 Q 50 90 100 110 T 200 110 T 300 110 T 400 110 T 500 110 T 600 110 V150 H0Z" fill="#9fd3e3"/><path d="M0 125 Q 50 108 100 125 T 200 125 T 300 125 T 400 125 T 500 125 T 600 125 V150 H0Z" fill="#6fb8d0"/>`;
      [[60, 40, 10], [90, 70, 6], [510, 30, 12], [540, 65, 7], [480, 80, 5], [120, 25, 5]].forEach(([x, y, r]) => { s += `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#6fb8d0" stroke-width="2.5"/>`; });
      s += `<g transform="translate(250 60)"><ellipse cx="0" cy="0" rx="26" ry="15" fill="#f2a65a"/><path d="M22 0 L42 -14 L42 14Z" fill="#f2a65a"/><circle cx="-12" cy="-3" r="3" fill="#1f4152"/></g>`;
      s += `<g transform="translate(360 45) scale(-.7 .7)"><ellipse cx="0" cy="0" rx="26" ry="15" fill="#e86a92"/><path d="M22 0 L42 -14 L42 14Z" fill="#e86a92"/><circle cx="-12" cy="-3" r="3" fill="#1f4152"/></g>`;
      return s;
    }
    case "space": {
      let s = "";
      for (let i = 0; i < 40; i++) s += `<circle cx="${Math.round(rnd() * 600)}" cy="${Math.round(rnd() * 142 + 4)}" r="${i % 4 ? 1.4 : 2.4}" fill="#fff" opacity="${i % 3 ? .6 : .95}"/>`;
      s += `<circle cx="90" cy="70" r="30" fill="#f5b84a"/><ellipse cx="90" cy="70" rx="50" ry="11" fill="none" stroke="#e86a92" stroke-width="5" transform="rotate(-18 90 70)"/>`;
      s += `<g transform="translate(500 75) rotate(35)"><path d="M0 -40 C 16 -24 16 16 10 28 H -10 C -16 16 -16 -24 0 -40Z" fill="#f4f1ff"/><circle cx="0" cy="-8" r="7" fill="#6aa7e0"/><path d="M-10 18 L-22 34 L-10 30Z M10 18 L22 34 L10 30Z" fill="#e86a92"/><path d="M-6 30 Q0 50 6 30Z" fill="#f5b84a"/></g>`;
      return s + star4(300, 30, 10, "#f5b84a") + star4(400, 110, 7, "#f4f1ff");
    }
    case "rainbow": {
      const cs = ["#f6a5a5", "#f8c99a", "#f6e39a", "#b9e0a5", "#a5cdf0", "#c9b2ec"];
      let s = ""; cs.forEach((c, i) => { const r = 120 - i * 14; s += `<path d="M${300 - r} 150 A ${r} ${r} 0 0 1 ${300 + r} 150" stroke="${c}" stroke-width="13" fill="none"/>`; });
      s += `<g fill="#fff"><circle cx="175" cy="140" r="22"/><circle cx="200" cy="132" r="26"/><circle cx="228" cy="142" r="20"/><circle cx="372" cy="142" r="20"/><circle cx="400" cy="132" r="26"/><circle cx="425" cy="140" r="22"/></g>`;
      return s;
    }
    case "sparkle":
      return star4(70, 50, 22, "#e9c46a") + star4(120, 100, 11, "#c9b2ec") + star4(30, 110, 8, "#e9c46a")
        + star4(530, 45, 22, "#e9c46a") + star4(480, 100, 11, "#c9b2ec") + star4(575, 110, 8, "#e9c46a")
        + star4(300, 28, 9, "#c9b2ec") + `<path d="M255 100 L270 72 L285 92 L300 62 L315 92 L330 72 L345 100Z" fill="#e9c46a"/><rect x="255" y="100" width="90" height="12" rx="3" fill="#e9c46a"/><circle cx="300" cy="60" r="5" fill="#e86a92"/>`;
    case "balloons":
    default:
      return B(70, 55, 30, "#e8a99f") + B(130, 40, 24, "#a9cf90") + B(30, 95, 20, "#f2c14e")
        + B(530, 55, 30, "#a5cdf0") + B(470, 40, 24, "#e8a99f") + B(570, 95, 20, "#c9b2ec");
  }
}

// ---- Helpers ---------------------------------------------------------------
const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
export function randId(n) { let s = ""; for (const x of randomBytes(n)) s += ALPHA[x % ALPHA.length]; return s; }
export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const firstName = (n) => (String(n || "").trim().split(/\s+/)[0] || "");

export function prettyDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "")) return d || "";
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
export function prettyTime(label) { return String(label || "").replace(/\s-\s/, " – "); }
export function ordinal(n) { n = parseInt(n, 10); if (!(n > 0)) return ""; const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

export function defaultHeadline(rec, inv) {
  const f = firstName(rec.childName) || "Our little one";
  const age = parseInt((inv && inv.age) || "", 10);
  return age > 0 ? `${f} is turning ${age}!` : `${f}'s Birthday Party`;
}
export function hostUrl(inv) { return `${SITE}/party-invite.html?i=${inv.id}&t=${inv.token}`; }
export function guestUrl(inv) { return `${SITE}/i/${inv.id}`; }
export function photoUrl(inv) { return inv && inv.photoV ? `${SITE}/api/invite-photo?i=${inv.id}&v=${inv.photoV}` : ""; }
export function ogImage(inv) { return photoUrl(inv) || `${SITE}/invite-${(inv && THEMES[inv.theme]) ? inv.theme : DEFAULT_THEME}.png`; }

// Google Calendar link for the party (Pacific time).
export function calendarUrl(rec, title) {
  const slot = PARTY_SLOTS.find(s => s.id === rec.partySlot);
  if (!slot || !/^\d{4}-\d{2}-\d{2}$/.test(rec.date || "")) return "";
  const hm = m => String(Math.floor(m / 60)).padStart(2, "0") + String(m % 60).padStart(2, "0") + "00";
  const d = rec.date.replace(/-/g, "");
  return "https://calendar.google.com/calendar/render?action=TEMPLATE"
    + "&text=" + encodeURIComponent(title)
    + "&dates=" + d + "T" + hm(slot.start) + "/" + d + "T" + hm(slot.end)
    + "&ctz=America/Los_Angeles"
    + "&location=" + encodeURIComponent("Little Haven Play Studio, " + STUDIO_ADDRESS)
    + "&details=" + encodeURIComponent("Please sign the waiver before you arrive: " + WAIVER_URL);
}

export function packageCounts(rec) {
  const p = PARTY_PACKAGES[rec.package] || null;
  return p ? { label: p.label, kidsIncl: p.kidsIncl, adultsIncl: p.adultsIncl } : null;
}

// Give a party its invitation links (once). Saves the party record. Returns it.
export async function ensureInvite(key, rec) {
  if (!rec) return rec;
  if (rec.invite && rec.invite.id && rec.invite.token) return rec;
  const id = randId(10);
  rec.invite = Object.assign({ theme: DEFAULT_THEME, headline: "", message: "", age: "", rsvpBy: "", photoV: 0, emailedCount: 0 },
    rec.invite || {}, { id, token: randId(24), createdAt: new Date().toISOString() });
  await invitesStore().setJSON("inv:" + id, { key });
  await partiesStore().setJSON(key, rec);
  return rec;
}

// Find the party behind an invitation id. Returns { key, rec } or null.
export async function loadByInvite(id) {
  if (!/^[a-z0-9]{6,20}$/.test(id || "")) return null;
  let m = null; try { m = await invitesStore().get("inv:" + id, { type: "json" }); } catch {}
  if (!m || !m.key) return null;
  let rec = null; try { rec = await partiesStore().get(m.key, { type: "json" }); } catch {}
  if (!rec || !rec.invite || rec.invite.id !== id) return null;
  return { key: m.key, rec };
}

export async function listRsvps(id) {
  const st = invitesStore(); const out = [];
  let keys = [];
  try { const r = await st.list({ prefix: "rsvp:" + id + ":" }); keys = (r.blobs || []).map(b => b.key); } catch {}
  for (const k of keys) { try { const v = await st.get(k, { type: "json" }); if (v) out.push(v); } catch {} }
  out.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return out;
}

export function rsvpTotals(list) {
  const yes = list.filter(r => r.attending === "yes");
  return {
    families: yes.length,
    kids: yes.reduce((n, r) => n + (Array.isArray(r.kids) ? r.kids.length : 0), 0),
    adults: yes.reduce((n, r) => n + (parseInt(r.adults, 10) || 0), 0),
    no: list.filter(r => r.attending === "no").length,
  };
}

// The block added to the host's "party is confirmed" email.
export function hostInviteBlockHtml(inv) {
  if (!inv || !inv.id) return "";
  return `<div style="background:#fdf1ec;border:1px solid #f0d9d2;border-radius:14px;padding:16px;margin:16px 0;text-align:center">
    <p style="margin:0 0 4px;font-weight:bold;color:#a85f59;font-size:16px">🎈 Your free digital invitation</p>
    <p style="margin:0 0 12px;color:#5c6470;font-size:14px">Pick a design, add a photo, and text the link to your guests. They RSVP and sign the waiver before the party.</p>
    <a href="${hostUrl(inv)}" style="display:inline-block;background:#c97d76;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:12px">Create your invitation →</a>
  </div>`;
}

// ---- Emails to guests --------------------------------------------------------
function waiverBlock() {
  return `<div style="background:#f3f0ff;border-radius:12px;padding:14px 16px;margin:14px 0">
      <p style="margin:0 0 6px;font-weight:bold;color:#5b4636">Please sign the waiver before you arrive</p>
      <p style="margin:0 0 10px;color:#5c6470;font-size:14px">Every child and adult needs a signed waiver to play. Grip socks are required for kids.</p>
      <a href="${WAIVER_URL}" style="display:inline-block;background:#7a6253;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:10px">Sign the waiver →</a>
    </div>`;
}

// Sent when the host asks us to email their invitation to a list of addresses.
export function guestInviteEmail(rec) {
  const inv = rec.invite || {};
  const headline = inv.headline || defaultHeadline(rec, inv);
  const f = firstName(rec.childName) || "the birthday child";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;line-height:1.6;max-width:560px;margin:0 auto">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 6px">You're invited! 🎈</h2>
    <p style="margin:0 0 4px;font-size:18px;font-weight:bold">${esc(headline)}</p>
    <p style="margin:0 0 14px;color:#5c6470">${esc(prettyDate(rec.date))} · ${esc(prettyTime(rec.slotLabel))}<br>${esc(STUDIO)}, ${esc(STUDIO_ADDRESS)}</p>
    ${inv.message ? `<p style="margin:0 0 14px;color:#5c6470;white-space:pre-line">${esc(inv.message)}</p>` : ""}
    <p style="margin:0 0 6px"><a href="${guestUrl(inv)}" style="display:inline-block;background:#c97d76;color:#fff;text-decoration:none;font-weight:bold;padding:13px 24px;border-radius:12px">View invitation & RSVP →</a></p>
    ${waiverBlock()}
  </div>`;
  return { subject: `You're invited to ${f}'s birthday party! 🎈`, html };
}

// The day before the party, to every family that RSVP'd yes with an email.
export function guestReminderEmail(rec, rsvp) {
  const inv = rec.invite || {};
  const f = firstName(rec.childName) || "the birthday";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;line-height:1.6;max-width:560px;margin:0 auto">
    <h2 style="color:#a85f59;font-weight:normal;margin:0 0 6px">See you tomorrow! 🎉</h2>
    <p style="margin:0 0 12px;color:#5c6470">Hi ${esc(firstName(rsvp.name) || "there")}, ${esc(f)}'s party is tomorrow, ${esc(prettyDate(rec.date))}, at ${esc(prettyTime(rec.slotLabel))}.</p>
    <p style="margin:0 0 12px;color:#5c6470">${esc(STUDIO)}<br><a href="${MAPS_URL}" style="color:#a85f59">${esc(STUDIO_ADDRESS)}</a></p>
    ${waiverBlock()}
    <p style="margin:0;color:#5c6470;font-size:13px">Plans changed? <a href="${guestUrl(inv)}" style="color:#a85f59">Update your RSVP</a>.</p>
  </div>`;
  return { subject: `Tomorrow: ${f}'s party at ${STUDIO} 🎈`, html };
}
