// POST /api/waiver-import   (admin key or staff PIN)
// Backfills waiver-signed date + adult names onto EXISTING loyalty cards from a
// WaiverMaster CSV export, matched by phone number. Never creates a new card.
// Never overwrites a field that already has something in it — only fills blanks.
// The browser parses the CSV and sends structured rows here; this function does
// the matching, the "most recent wins" dedup, and the actual (or previewed) write.
//
//   { key, action:"preview", rows:[{phone, date, adults:[names], participants:[names]}] }
//   { key, action:"run",     rows:[...same shape...] }
//
// rows.date should be an ISO date string (YYYY-MM-DD) — dedup picks the latest
// per phone number before doing anything else.
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";

function last4(phone) { return (phone || "").toString().replace(/\D/g, "").slice(-4); }
function normName(s) { return (s || "").toString().toLowerCase().replace(/[^a-z]/g, ""); }

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const dryRun = (b.action || "preview") !== "run";
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return json({ error: "No rows to import." }, 400);

  // Dedup: keep only the most recent row per phone4.
  const byPhone4 = {};
  for (const r of rows) {
    const p4 = last4(r.phone);
    if (p4.length !== 4) continue;
    const existing = byPhone4[p4];
    if (!existing || (r.date || "") > (existing.date || "")) byPhone4[p4] = r;
  }

  const loyalty = getStore("loyalty");
  const allKeys = await listAllKeys(loyalty, { prefix: "card:" });
  // Index existing cards by phone4 once, so we're not re-scanning per row.
  const cardsByPhone4 = {};
  for (const k of allKeys) {
    let rec = null; try { rec = await loyalty.get(k, { type: "json" }); } catch {}
    if (!rec || !rec.phone4) continue;
    (cardsByPhone4[rec.phone4] = cardsByPhone4[rec.phone4] || []).push(rec);
  }

  const results = [];   // one entry per phone4 that matched an existing family
  let noMatch = 0;

  for (const p4 of Object.keys(byPhone4)) {
    const row = byPhone4[p4];
    const cards = cardsByPhone4[p4];
    if (!cards || !cards.length) { noMatch++; continue; }

    // Soft confidence check: does any name in this row resemble any name already
    // associated with this family (a card's child name, or an already-on-file
    // waiver adult)? If NOTHING overlaps at all, this phone4 might coincidentally
    // match a different, unrelated family — flag it rather than silently apply.
    const rowNames = [...(row.adults || []), ...(row.participants || [])]
      .filter(Boolean).map(normName).filter(Boolean);
    const cardNames = [];
    for (const c of cards) {
      if (c.childName) cardNames.push(normName(c.childName));
      for (const a of (c.waiverAdults || [])) if (a && a.name) cardNames.push(normName(a.name));
    }
    const overlap = rowNames.some(rn => cardNames.some(cn => cn && rn && (cn.includes(rn) || rn.includes(cn))));
    const confidence = (cardNames.length === 0) ? "new" : (overlap ? "match" : "check");

    const entry = { phone4: p4, date: row.date, adults: row.adults || [], participants: row.participants || [],
      confidence, cards: [], willFillDate: 0, willFillAdults: 0 };

    for (const card of cards) {
      const cardInfo = { code: card.code, childName: card.childName, hadDate: !!card.waiverSigned, hadAdults: (card.waiverAdults || []).length > 0 };
      entry.cards.push(cardInfo);

      let touched = false;
      if (!card.waiverSigned && row.date) {
        cardInfo.willSetDate = row.date;
        entry.willFillDate++;
        if (!dryRun) { card.waiverSigned = row.date; touched = true; }
      }

      if ((!card.waiverAdults || card.waiverAdults.length === 0) && row.adults && row.adults.length) {
        cardInfo.willSetAdults = row.adults;
        entry.willFillAdults++;
        if (!dryRun) {
          card.waiverAdults = row.adults.map(n => ({ name: n, signedDate: row.date || null }));
          touched = true;
        }
      }

      if (touched) {
        card.history = Array.isArray(card.history) ? card.history : [];
        card.history.push({ at: new Date().toISOString(), action: "waiver-imported", from: "WaiverMaster CSV" });
        try { await loyalty.setJSON("card:" + card.code, card); } catch {}
      }
    }
    results.push(entry);
  }

  const totals = {
    familiesInFile: Object.keys(byPhone4).length,
    familiesMatched: results.length,
    familiesNoCard: noMatch,
    cardsWithDateFilled: results.reduce((s, r) => s + r.willFillDate, 0),
    cardsWithAdultsFilled: results.reduce((s, r) => s + r.willFillAdults, 0),
    flaggedForReview: results.filter(r => r.confidence === "check").length,
  };

  return json({ ok: true, dryRun, totals, results });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/waiver-import" };
