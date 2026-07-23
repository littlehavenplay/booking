// POST /api/arrivals  (admin key or staff PIN)
// Tracks who has physically arrived (checked in) for a given day. Keyed by date.
//   { key, date, action:"get" }                    -> { ok, arrivals:{ id:true } }
//   { key, date, id, arrived:true|false, action:"set" } -> { ok, arrivals }
import { getStore } from "@netlify/blobs";
import { addPunch, sendFamilyPunch } from "./lib-loyalty.js";

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

    // ---- Loyalty: on arrival, punch each child on this booking (once). The punch
    // job was queued at booking time; legacy-card bookings never get a job, so they
    // never earn a punch. Best-effort — never blocks the arrival toggle.
    let loyaltyPunches = [];
    if (b.arrived) {
      try {
        const loyalty = getStore("loyalty");
        const jobs = getStore("loyaltyjobs");
        let children = null, phone4 = null, email = (b.email || "").toString();
        let commit = null;   // marks the source as punched so we never double-punch

        // Fast path: the punch job queued at booking time.
        let job = null;
        try { job = await jobs.get("job:" + id, { type: "json" }); } catch {}
        if (job && job.punched) {
          children = null;                                   // already punched — do nothing
        } else if (job && Array.isArray(job.children) && job.phone4) {
          children = job.children; phone4 = job.phone4; email = job.email || email;
          commit = async () => { job.punched = true; job.punchedAt = new Date().toISOString(); try { await jobs.setJSON("job:" + id, job); } catch {} };
        } else {
          // Self-heal: no usable job (older booking or any hiccup at booking time). Read the
          // booking record itself so EVERY check-in issues a card (if missing) and punches.
          const bstore = getStore("bookings");
          let list = []; try { list = (await bstore.list()).blobs || []; } catch {}
          for (const bl of list) {
            if (!bl.key.startsWith(date + "__")) continue;
            let rec = null; try { rec = await bstore.get(bl.key, { type: "json" }); } catch {}
            const entry = rec && Array.isArray(rec.bookings) ? rec.bookings.find(x => x.id === id) : null;
            if (!entry) continue;
            if (!entry.loyaltyPunched && !entry.legacyUsed && Array.isArray(entry.childNames) && entry.childNames.length) {
              const digits = (entry.phone || "").toString().replace(/\D/g, "");
              if (digits.length >= 4) {
                children = entry.childNames; phone4 = digits.slice(-4); email = entry.email || email;
                commit = async () => { entry.loyaltyPunched = true; try { await bstore.setJSON(bl.key, rec); } catch {} };
              }
            }
            break;
          }
        }

        // addPunch CREATES the card if the child doesn't have one yet, then punches it.
        if (children && phone4) {
          const isFamily = children.filter(c => c && c.first && c.last).length > 1;
          for (const ch of children) {
            if (ch && ch.first && ch.last) {
              try {
                const r = await addPunch(loyalty, { first: ch.first, last: ch.last, phone4, email, suppressEmail: isFamily });
                if (!r.error) loyaltyPunches.push({ childName: r.childName, code: r.code, punches: r.punches,
                  needed: r.needed, rewardIssued: r.rewardIssued, rewardCode: r.rewardCode });
              } catch {}
            }
          }
          // Family: at most ONE combined email, and only if someone earned a free visit.
          if (isFamily && email && loyaltyPunches.some(p => p.rewardIssued)) {
            try { await sendFamilyPunch(email, loyaltyPunches); } catch {}
          }
          if (commit) { try { await commit(); } catch {} }
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
