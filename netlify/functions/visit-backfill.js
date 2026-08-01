// POST /api/visit-backfill   (admin key or staff PIN)
// One-time (safely re-runnable) tool: scans past bookings that were actually
// checked in (per the arrivals record — the same source of truth used live) and
// adds visit-history entries to each matching child's EXISTING loyalty card.
// Never creates a new card and never touches waiver fields — only adds visits.
// Uses the exact same card-matching logic as live check-in (resolveCard), so a
// child only gets backfilled onto the card that already legitimately belongs to
// them; if no card exists for a child, that visit is skipped, not invented.
//
//   { key, action:"preview" }  -> counts what WOULD be added, no writes
//   { key, action:"run" }      -> actually adds the visits
//
// Safe to re-run: each visit is keyed by bookingId, so anything already present
// (from this backfill or from live check-ins) is never duplicated.
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { resolveCard } from "./lib-loyalty.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const dryRun = (b.action || "preview") !== "run";

  const bstore = getStore("bookings");
  const astore = getStore("arrivals");
  const loyalty = getStore("loyalty");

  const bookingKeys = await listAllKeys(bstore);
  const arrivalsCache = {};   // date -> { bookingId: true }

  let scanned = 0, arrived = 0, matched = 0, added = 0, alreadyHad = 0, noCard = 0, skippedLegacy = 0;
  const cardCache = {};       // avoid re-fetching/re-saving the same card repeatedly within one run

  for (const key of bookingKeys) {
    const date = key.split("__")[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    let rec = null; try { rec = await bstore.get(key, { type: "json" }); } catch {}
    if (!rec || !Array.isArray(rec.bookings)) continue;

    if (!(date in arrivalsCache)) {
      try { arrivalsCache[date] = (await astore.get(date, { type: "json" })) || {}; } catch { arrivalsCache[date] = {}; }
    }
    const arrivalsMap = arrivalsCache[date];

    for (const entry of rec.bookings) {
      scanned++;
      if (!arrivalsMap[entry.id]) continue;                 // never checked in — skip
      arrived++;
      if (entry.legacyUsed) { skippedLegacy++; continue; }   // legacy prepaid visits aren't loyalty visits
      if (!Array.isArray(entry.childNames) || !entry.childNames.length) continue;
      const digits = (entry.phone || "").toString().replace(/\D/g, "");
      if (digits.length < 4) continue;
      const phone4 = digits.slice(-4);
      const slotLabel = key.split("__")[1] || "";

      for (const ch of entry.childNames) {
        if (!ch || !ch.first || !ch.last) continue;
        const { code } = await resolveCard(loyalty, ch.first, ch.last, phone4, true);
        if (!code) { noCard++; continue; }                   // no existing card for this child — don't invent one
        matched++;

        if (!cardCache[code]) {
          let card = null; try { card = await loyalty.get("card:" + code, { type: "json" }); } catch {}
          if (!card) { noCard++; continue; }
          card.visits = Array.isArray(card.visits) ? card.visits : [];
          cardCache[code] = { card, dirty: false, existingIds: new Set(card.visits.map(v => v.bookingId).filter(Boolean)) };
        }
        const c = cardCache[code];
        if (c.existingIds.has(entry.id)) { alreadyHad++; continue; }   // already backfilled or already logged live

        if (!dryRun) {
          c.card.visits.push({
            date, at: entry.at || (date + "T12:00:00.000Z"), slotLabel, bookingId: entry.id,
            admission: ch.admission || "regular", freeAdmission: !!ch._freeAdmission,
            discountCode: entry.discountCode || null, discountPct: entry.discountPct || 0,
            weekdaySpecialLabel: entry.weekdaySpecialLabel || "",
            military: (entry.militaryAmount || 0) > 0 && (entry.militaryChildren || []).some(n => n && n.toLowerCase() === (ch.first + " " + ch.last).toLowerCase()),
            backfilled: true,
          });
          c.dirty = true;
        }
        c.existingIds.add(entry.id);
        added++;
      }
    }
  }

  if (!dryRun) {
    for (const code of Object.keys(cardCache)) {
      const c = cardCache[code];
      if (!c.dirty) continue;
      c.card.visits.sort((x, y) => (y.date || "").localeCompare(x.date || "") || (y.at || "").localeCompare(x.at || ""));
      c.card.visits = c.card.visits.slice(0, 200);
      try { await loyalty.setJSON("card:" + code, c.card); } catch {}
    }
  }

  return json({ ok: true, dryRun, scanned, arrived, skippedLegacy, matched, added, alreadyHad, noCard,
    cardsTouched: Object.values(cardCache).filter(c => c.dirty || dryRun).length });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/visit-backfill" };
