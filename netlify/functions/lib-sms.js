// Text-message (SMS) marketing list — opt-ins only.
//
// The site does NOT send texts. It collects people who have actually agreed to
// marketing texts (with the date, where, and the exact wording they agreed to),
// so the list can be exported and uploaded to a texting service (SimpleTexting,
// EZ Texting, ...). That service sends the texts and handles STOP replies
// automatically. Opt-outs from the service can be pasted back in here so this
// list never re-adds someone who said stop.
//
// Store "smslist":  sub:<10-digit phone> -> { phone, name, status, source,
//                   consentAt, consentText, unsubAt, unsubSource, history[] }
import { getStore } from "@netlify/blobs";

export const SMS_STORE = "smslist";
export const smsStore = () => getStore({ name: SMS_STORE, consistency: "strong" });

// The wording shown next to every opt-in checkbox. Saved with each signup.
export const CONSENT_TEXT =
  "Yes, text me Little Haven Play Studio news, events & deals. Recurring automated marketing texts to the number provided. " +
  "Consent isn't required to buy anything. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.";

// The wording under the website pop-up's button. Tapping the button is the agreement.
export const POPUP_CONSENT_TEXT =
  "By tapping Text me deals, you agree to receive recurring automated marketing texts from Little Haven Play Studio at this number. " +
  "Consent isn't required to buy anything. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.";

// US numbers only: returns 10 digits, or "" if it isn't a usable number.
export function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length !== 10 || /^[01]/.test(d)) return "";
  return d;
}
export const prettyPhone = (d) => d && d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d;

// Add (or re-confirm) an opt-in. A number that previously opted out is only
// re-subscribed when the person themselves opts in again (reoptin: true) —
// staff imports never override a STOP.
export async function subscribe({ phone, name, source, consentText, reoptin }) {
  const d = normPhone(phone);
  if (!d) return { ok: false, error: "Enter a 10-digit US mobile number." };
  const st = smsStore(); const now = new Date().toISOString();
  let rec = null; try { rec = await st.get("sub:" + d, { type: "json" }); } catch {}
  if (rec && rec.status === "unsubscribed" && !reoptin) return { ok: true, phone: d, skipped: "opted-out" };
  const was = rec && rec.status;
  rec = rec || { phone: d, history: [] };
  rec.name = (String(name || "").trim().slice(0, 60)) || rec.name || "";
  rec.status = "subscribed";
  rec.source = rec.source || source || "website";
  rec.consentAt = now; rec.consentText = consentText || CONSENT_TEXT;
  rec.history = (rec.history || []).concat([{ at: now, action: "opt-in", source: source || "website" }]).slice(-20);
  delete rec.unsubAt;
  await st.setJSON("sub:" + d, rec);
  return { ok: true, phone: d, already: was === "subscribed" };
}

export async function unsubscribe(phone, source) {
  const d = normPhone(phone);
  if (!d) return { ok: false };
  const st = smsStore(); const now = new Date().toISOString();
  let rec = null; try { rec = await st.get("sub:" + d, { type: "json" }); } catch {}
  rec = rec || { phone: d, history: [] };
  if (rec.status === "unsubscribed") return { ok: true, phone: d, already: true };
  rec.status = "unsubscribed"; rec.unsubAt = now; rec.unsubSource = source || "website";
  rec.history = (rec.history || []).concat([{ at: now, action: "opt-out", source: source || "website" }]).slice(-20);
  await st.setJSON("sub:" + d, rec);
  return { ok: true, phone: d };
}

export async function listAll() {
  const st = smsStore(); const out = [];
  let keys = []; try { const r = await st.list({ prefix: "sub:" }); keys = (r.blobs || []).map(b => b.key); } catch {}
  for (const k of keys) { try { const v = await st.get(k, { type: "json" }); if (v) out.push(v); } catch {} }
  return out;
}
