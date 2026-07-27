// POST /api/pass-issue  (admin key or staff PIN)
// Legacy prepaid punch cards are DISCONTINUED — no new ones can be minted and
// existing ones can't be reloaded. This function now does exactly one thing:
// correct an existing legacy card's exact visit count and refresh its expiry
// (e.g. to undo a mistaken redemption or fix a data error). New families and
// anyone whose legacy card runs out are on the free Loyalty Punch Card program
// instead — see lib-loyalty.js / graduateLegacyCard.
// Body: { key, fixCode, setVisits }
import { getStore } from "@netlify/blobs";
import { PASSES, passExpiryDate } from "./lib-settings.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  // ---- Fix / correct an EXISTING card — the only thing this endpoint does now. ----
  // Sets the EXACT visits remaining (not additive) and refreshes the expiry to a
  // valid future date. Use this to undo a mistaken redemption or repair a bad expiry.
  const fixCode = (b.fixCode || "").toString().trim().toUpperCase();
  if (!fixCode) return json({ error: "Legacy punch cards can no longer be issued or reloaded — that program has been retired. This tool only corrects an existing card's visit count; enter its code." }, 400);

  const storeF = getStore("passes");
  let rec = null;
  try { rec = await storeF.get("pass:" + fixCode, { type: "json" }); } catch { rec = null; }
  if (!rec) return json({ error: "That punch card code wasn't found." }, 404);
  const setVisits = parseInt(b.setVisits, 10);
  if (!Number.isFinite(setVisits) || setVisits < 0) return json({ error: "Enter the exact number of visits to set (0 or more)." }, 400);
  const nowF = new Date();
  const tId = rec.admission === "infant" ? "I8" : rec.admission === "sibling" ? "S8" : "R8";
  const tF = PASSES[tId] || {};
  const expF = passExpiryDate(nowF, tF.expiryMonths, rec.admission, rec.dobMonth, rec.dobYear);
  rec.visitsRemaining = setVisits;
  rec.active = true;
  rec.expiry = expF.toISOString().slice(0, 10);
  rec.reminderSentAt = null;
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  rec.history.push({ at: nowF.toISOString(), action: "corrected", setVisits, expiry: rec.expiry });
  try { await storeF.setJSON("pass:" + fixCode, rec); }
  catch { return json({ error: "Couldn't update the card. Try again." }, 502); }
  return json({ ok: true, fixed: true, code: fixCode, label: rec.label || "",
    visitsRemaining: rec.visitsRemaining, expiry: rec.expiry });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/pass-issue" };
