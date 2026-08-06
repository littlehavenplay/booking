// POST /api/arrivals  (admin key or staff PIN)
// Tracks who has physically arrived (checked in) for a given day. Keyed by date.
//   { key, date, action:"get" }                    -> { ok, arrivals:{ id:true } }
//   { key, date, id, arrived:true|false, action:"set" } -> { ok, arrivals }
import { getStore } from "@netlify/blobs";
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
  try { map = (await store.get(date, { type: "json" })) || {}; } catch { map = {}; }

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
    if (b.arrived) {
      try {
        const loyalty = getStore("loyalty");
        const bstore = getStore("bookings");
        const allKeys = await listAllKeys(bstore);
        let entry = null, rec = null, bookingKey = null;
        for (const key of allKeys) {
          if (!key.startsWith(date + "__")) continue;
          let r = null; try { r = await bstore.get(key, { type: "json" }); } catch {}
          const e = r && Array.isArray(r.bookings) ? r.bookings.find(x => x.id === id) : null;
          if (e) { entry = e; rec = r; bookingKey = key; break; }
        }

        if (entry && !entry.loyaltyPunched && !entry.legacyUsed && Array.isArray(entry.childNames) && entry.childNames.length) {
          const digits = (entry.phone || "").toString().replace(/\D/g, "");
          if (digits.length >= 4) {
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
                  const r = await issueCode(loyalty, { first: ch.first, last: ch.last, phone4, email, suppressEmail: true, visitMeta });
                  loyaltyPunches.push({ childName: r.childName, code: r.code, freeAdmission: true });
                } else {
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
    return json({ ok: true, arrivals: map, coffee, loyaltyPunches });
  }
  return json({ ok: true, arrivals: map });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const config = { path: "/api/arrivals" };
