// POST /api/arrivals  (admin key or staff PIN)
// Tracks who has physically arrived (checked in) for a given day. Keyed by date.
//   { key, date, action:"get" }                    -> { ok, arrivals:{ id:true } }
//   { key, date, id, arrived:true|false, action:"set" } -> { ok, arrivals }
import { getStore } from "@netlify/blobs";
import { findFamilyByCode, creditReferrer, reconcileLots, lotSummaryLines, last4 as refLast4 } from "./lib-referral.js";
import { addPunch, issueCode, sendFamilyPunch } from "./lib-loyalty.js";
import { listAllKeys } from "./lib-blobs.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "";
  const staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const date = (b.date || "").toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a valid date." }, 400);

  const store = getStore("arrivals");
  let map = {};
  try { map = (await store.get(date, { type: "json", consistency: "strong" })) || {}; } catch { map = {}; }

  if ((b.action || "") === "set") {
    const id = (b.id || "").toString();
    if (!id) return json({ error: "Missing id." }, 400);
    // Prevent marking a FUTURE-dated booking as arrived (avoids accidental early loyalty punches).
    if (b.arrived) {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      if (date > today) return json({ error: "This is a future booking — you can only mark it arrived on the day of the visit. No punch was given." }, 400);
    }
    if (b.arrived) map[id] = true; else delete map[id];
    try { await store.setJSON(date, map); } catch { return json({ error: "Couldn't save. Try again." }, 502); }

    // ---- Loyalty: on arrival, punch each child on this booking (once). This
    // reads the actual booking record directly — the one authoritative source
    // of truth — rather than relying on a separately-queued "job" as a fast
    // path with this lookup only as a rarely-exercised fallback. That split
    // was the cause of at least one real missed punch: the fallback used an
    // unpaginated store listing, so on a day with enough bookings to span more
    // than one page, a booking outside the first page could be silently
    // skipped — no error, no punch, nothing to notice until a parent asked
    // why their count was short. Every check-in now goes through this one
    // reliable, fully-paginated path instead. Best-effort — never blocks the
    // arrival toggle itself.
    let loyaltyPunches = [];
    // A plain-language reason so the check-in screen shows the RIGHT message and
    // only raises a real warning when something actually needs fixing:
    //   reward       -> a child earned their free 8th visit
    //   punched      -> normal paid punch (includes gift-card & store-credit payments)
    //   free         -> free-admission code or birthday reward: card set up, no punch (correct)
    //   already      -> this booking was already punched on a previous check-in (fine)
    //   legacy       -> a legacy 2-hr prepaid session: no loyalty punch (correct)
    //   no_children  -> no child names on the booking, so nothing to punch
    //   no_phone     -> a paid booking WITH children but no phone on file (the one real problem)
    //   not_found    -> couldn't find the booking record (e.g. a manual/walk-in arrival)
    let loyaltyStatus = null;
    if (b.arrived) {
      try {
        const loyalty = getStore("loyalty");
        const bstore = getStore("bookings");
        const allKeys = await listAllKeys(bstore);
        let entry = null, rec = null, bookingKey = null;
        for (const key of allKeys) {
          if (!key.startsWith(date + "__")) continue;
          let r = null; try { r = await bstore.get(key, { type: "json", consistency: "strong" }); } catch {}
          const e = r && Array.isArray(r.bookings) ? r.bookings.find(x => x.id === id) : null;
          if (e) { entry = e; rec = r; bookingKey = key; break; }
        }

        // ---- Referral payout ------------------------------------------------
        // The friend has physically turned up, so the referrer earns their $5.
        // Guarded by referralPaid so a second check-in can't pay twice.
        if (entry && entry.referredBy && !entry.referralPaid) {
          try {
            const fam = await findFamilyByCode(entry.referredBy);
            if (fam) {
              const credit = await creditReferrer(fam, { friendName: entry.name || "" });
              if (credit) {
                entry.referralPaid = true;
                entry.referralCreditCode = credit.code;
                try { await bstore.setJSON(bookingKey, rec); } catch {}
                try {
                  const rstore = getStore("referrals");
                  const rk = "ref:" + entry.id;
                  let rr = null; try { rr = await rstore.get(rk, { type: "json" }); } catch {}
                  rr = rr || { id: entry.id, refCode: fam.code, referrerPhone4: fam.phone4,
                               referrerName: fam.name || "", friendPhone4: refLast4(entry.phone),
                               friendName: entry.name || "", friendEmail: entry.email || "",
                               source: "online", at: new Date().toISOString(), bookingDate: date };
                  rr.paidAt = new Date().toISOString();
                  rr.creditCode = credit.code;
                  await rstore.setJSON(rk, rr);
                } catch {}
                await emailReferrer(fam, credit, entry.name || "your friend");
              }
            }
          } catch {}
        }

        if (!entry) {
          loyaltyStatus = "not_found";
        } else if (entry.legacyUsed) {
          loyaltyStatus = "legacy";
        } else if (!(Array.isArray(entry.childNames) && entry.childNames.length)) {
          loyaltyStatus = "no_children";
        } else if (entry.loyaltyPunched) {
          loyaltyStatus = "already";   // already handled on a prior check-in — never double-punch
        } else {
          const digits = (entry.phone || "").toString().replace(/\D/g, "");
          if (digits.length < 4) {
            loyaltyStatus = "no_phone";
          } else {
            const phone4 = digits.slice(-4);
            const email = entry.email || (b.email || "").toString();
            const slotLabel = (bookingKey.split("__")[1] || "");
            const children = entry.childNames;
            const isFamily = children.filter(c => c && c.first && c.last).length > 1;

            // addPunch/issueCode CREATE the card if the child doesn't have one yet,
            // then punch it — or, for a free admission, just create/link the card
            // with no punch, since nothing was paid. Either way, a visit gets
            // logged (via visitMeta) so history always reflects the actual visit.
            for (const ch of children) {
              if (!(ch && ch.first && ch.last)) continue;
              const visitMeta = { date, slotLabel, admission: ch.admission || "regular", bookingId: id, source: "online",
                discountCode: entry.discountCode || null, discountPct: entry.discountPct || 0,
                weekdaySpecialLabel: entry.weekdaySpecialLabel || "",
                military: (entry.militaryAmount || 0) > 0 && (entry.militaryChildren || []).some(n => n && n.toLowerCase() === (ch.first + " " + ch.last).toLowerCase()) };
              try {
                if (ch._freeAdmission) {
                  // Free-admission code or birthday reward → set up / link the card, NO punch.
                  const r = await issueCode(loyalty, { first: ch.first, last: ch.last, phone4, email, suppressEmail: true, visitMeta });
                  loyaltyPunches.push({ childName: r.childName, code: r.code, freeAdmission: true });
                } else {
                  // Everything else (card, gift card, store credit, discount, military,
                  // weekday special) is a paid visit → punch the card.
                  const r = await addPunch(loyalty, { first: ch.first, last: ch.last, phone4, email, suppressEmail: isFamily, visitMeta });
                  if (!r.error) loyaltyPunches.push({ childName: r.childName, code: r.code, punches: r.punches,
                    needed: r.needed, rewardIssued: r.rewardIssued, rewardCode: r.rewardCode });
                }
              } catch {}
            }
            // Family: at most ONE combined email, and only if someone earned a free visit.
            if (isFamily && email && loyaltyPunches.some(p => p.rewardIssued)) {
              try { await sendFamilyPunch(email, loyaltyPunches); } catch {}
            }
            entry.loyaltyPunched = true;
            try { await bstore.setJSON(bookingKey, rec); } catch {}

            if (!loyaltyPunches.length) loyaltyStatus = "no_children";
            else if (loyaltyPunches.some(p => p.rewardIssued)) loyaltyStatus = "reward";
            else if (loyaltyPunches.some(p => !p.freeAdmission)) loyaltyStatus = "punched";
            else loyaltyStatus = "free";
          }
        }
      } catch {}
    }

    // Free-coffee perk is LEGACY punch-card-holders only.
    let coffee = false;
    if (b.arrived) {
      const email = (b.email || "").toString().trim().toLowerCase();
      if (email) {
        try {
          const passes = getStore("passes");
          const { blobs } = await passes.list({ prefix: "pass:" });
          for (const bl of (blobs || [])) {
            const p = await passes.get(bl.key, { type: "json" });
            if (p && p.active !== false && (p.visitsRemaining || 0) > 0 && (p.buyerEmail || "").toString().trim().toLowerCase() === email) { coffee = true; break; }
          }
        } catch {}
      }
    }
    return json({ ok: true, arrivals: map, coffee, loyaltyPunches, loyaltyStatus });
  }
  return json({ ok: true, arrivals: map });
};

// Tell the referrer they earned it, and spell out every expiry date so the
// oldest $5 creates the urgency to come back.
async function emailReferrer(fam, credit, friendName) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const studio = process.env.STUDIO_NAME || "Little Haven Play Studio";
  const bcc = process.env.STUDIO_EMAIL || "";
  const to = fam.email || credit.email;
  if (!key || !to) return;
  reconcileLots(credit);
  const lines = lotSummaryLines(credit);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `
  <div style="font-family:Nunito,Arial,sans-serif;max-width:560px;margin:0 auto;color:#2a2622">
    <h2 style="color:#a85f59;font-weight:normal">Your friend came to play! 🎈</h2>
    <p style="color:#5c6470">${esc(friendName)} just visited us — thank you for sending them our way.
    We've added <b>$5</b> to your referral credit.</p>
    <div style="background:#e7f0df;border:1px solid #c2d7bd;border-radius:14px;padding:16px;margin:14px 0;text-align:center">
      <div style="font-size:.75rem;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:#5c6470">Your credit code</div>
      <div style="font-family:monospace;font-size:1.6rem;font-weight:bold;color:#3f5d33;margin:6px 0">${esc(credit.code)}</div>
      <div style="font-size:1.1rem;font-weight:bold;color:#2a2622">Balance: $${((credit.amount || 0) / 100).toFixed(2)}</div>
    </div>
    ${lines.length ? `<p style="color:#5c6470;margin:0 0 4px"><b>Use it before it expires:</b></p>
    <ul style="color:#5c6470;margin:0 0 14px;padding-left:20px">${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
    <p style="color:#5c6470">Enter the code in the <b>store credit</b> box when you book. It works alongside any
    discount we're running, so you can use it on a promo day too.</p>
    <p style="color:#5c6470;font-size:13px">Keep sharing — every friend who visits adds another $5. — ${studio}</p>
  </div>`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${studio} <${from}>`, to: [to], bcc: bcc ? [bcc] : undefined,
        subject: `You earned $5 — ${friendName} came to play!`, html }),
    });
  } catch {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/arrivals" };
