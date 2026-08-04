// POST /api/waiver-import   (admin key or staff PIN)
//
// Imports a WaiverMaster CSV export and reconciles it against EXISTING loyalty
// cards. This is a MERGE, not a blind overwrite and not a fill-blanks-only tool:
//   - Matches each CSV submission to a specific card by phone number AND the
//     child's name (not phone number alone — two unrelated families can share
//     the same last-4 digits, confirmed in real data, so phone alone isn't safe).
//   - If the same child appears in more than one submission (updated waiver,
//     or a different guardian signed at a different visit), every adult from
//     every matching submission is combined onto that one card — nobody's name
//     gets dropped just because a later submission didn't repeat it.
//   - The most recent submission date becomes the card's waiver-signed date.
//   - Never creates a new card.
//   - Flags (does NOT silently touch) any card whose phone number shows up in
//     the file but whose child's name never appears in any of that number's
//     submissions — that's the signature of a card linked to the wrong family,
//     or two different families coincidentally sharing a phone's last 4 digits.
//     Staff review and fix these by hand via "Manage an existing card."
//   - Separately reports every card in the WHOLE loyalty system with no waiver
//     date on file at all, whether or not it appears in this file, so nothing
//     missing gets missed.
//
//   { key, action:"preview", rows:[{phone, date, adults:[names], participants:[names]}] }
//   { key, action:"run",     rows:[...same shape...] }
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";

function last4(phone) { return (phone || "").toString().replace(/\D/g, "").slice(-4); }
function normName(s) { return (s || "").toString().toLowerCase().replace(/[^a-z]/g, ""); }
function firstNameOf(s) { return normName((s || "").toString().trim().split(/\s+/)[0] || ""); }

// Does this CSV participant name plausibly refer to this card's child? Many
// WaiverMaster entries only have a first name (no last name), so match on
// first name, and treat a full last-name match as extra confirmation when
// both sides actually have one.
function childMatches(participant, cardChildName) {
  const pFirst = firstNameOf(participant);
  const cFirst = firstNameOf(cardChildName);
  if (!pFirst || !cFirst) return false;
  if (pFirst !== cFirst) return false;
  const pFull = normName(participant), cFull = normName(cardChildName);
  const pRest = pFull.slice(pFirst.length), cRest = cFull.slice(cFirst.length);
  if (pRest && cRest && pRest !== cRest && !pRest.includes(cRest) && !cRest.includes(pRest)) return false;
  return true;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const dryRun = (b.action || "preview") !== "run";
  const rows = (Array.isArray(b.rows) ? b.rows : [])
    .map(r => ({ ...r, phone4: last4(r.phone) }))
    .filter(r => r.phone4.length === 4);
  if (!rows.length) return json({ error: "No usable rows found in that file." }, 400);

  const loyalty = getStore("loyalty");
  const allKeys = await listAllKeys(loyalty, { prefix: "card:" });
  const allCards = [];
  const cardsByPhone4 = {};
  for (const k of allKeys) {
    let rec = null; try { rec = await loyalty.get(k, { type: "json" }); } catch {}
    if (!rec) continue;
    allCards.push(rec);
    if (rec.phone4) (cardsByPhone4[rec.phone4] = cardsByPhone4[rec.phone4] || []).push(rec);
  }

  const rowsByPhone4 = {};
  for (const r of rows) (rowsByPhone4[r.phone4] = rowsByPhone4[r.phone4] || []).push(r);

  const matched = [];          // cards successfully reconciled
  const mislinked = [];        // phone matches, but no child in the file matches this card
  const unmatchedRows = [];    // csv rows whose phone4 has no card at all
  const usedRowIdx = new Set();

  for (const p4 of Object.keys(rowsByPhone4)) {
    const csvRows = rowsByPhone4[p4];
    const cards = cardsByPhone4[p4] || [];
    if (!cards.length) { unmatchedRows.push(...csvRows); continue; }

    for (const card of cards) {
      const matchingRows = csvRows.filter(r => (r.participants || []).some(p => childMatches(p, card.childName)));
      if (!matchingRows.length) continue;   // this card gets no update from this phone4's rows
      matchingRows.forEach(r => usedRowIdx.add(r));

      // Merge: union of adults already on the card + every adult from every
      // matching submission, deduped by normalized name (keeps the FULL name
      // with the most characters when the same person appears with varying
      // detail, e.g. "Samantha" vs "Samantha Jensen").
      const byNorm = new Map();
      for (const a of (card.waiverAdults || [])) {
        if (a && a.name) byNorm.set(normName(a.name), { name: a.name, signedDate: a.signedDate || null });
      }
      let latestDate = card.waiverSigned || null;
      for (const r of matchingRows) {
        for (const name of (r.adults || [])) {
          const key = normName(name);
          if (!key) continue;
          const existing = byNorm.get(key);
          if (!existing || name.length > existing.name.length) {
            byNorm.set(key, { name, signedDate: r.date || existing?.signedDate || null });
          } else if (r.date && (!existing.signedDate || r.date > existing.signedDate)) {
            existing.signedDate = r.date;
          }
        }
        if (r.date && (!latestDate || r.date > latestDate)) latestDate = r.date;
      }
      const mergedAdults = [...byNorm.values()];

      const before = { waiverSigned: card.waiverSigned || null, adultCount: (card.waiverAdults || []).length };
      const changed = (latestDate !== before.waiverSigned) || (mergedAdults.length !== before.adultCount);

      matched.push({
        code: card.code, childName: card.childName, phone4: p4,
        submissionCount: matchingRows.length, submissionDates: matchingRows.map(r => r.date).sort(),
        before, after: { waiverSigned: latestDate, adultCount: mergedAdults.length, adultNames: mergedAdults.map(a => a.name) },
        changed,
      });

      if (!dryRun && changed) {
        card.waiverSigned = latestDate;
        card.waiverAdults = mergedAdults;
        card.history = Array.isArray(card.history) ? card.history : [];
        card.history.push({ at: new Date().toISOString(), action: "waiver-imported", from: "WaiverMaster CSV", submissions: matchingRows.length });
        try { await loyalty.setJSON("card:" + card.code, card); } catch {}
      }
    }

    // Any card at this phone4 that got zero matching rows, while the file DOES
    // have submissions for this phone number — that's the mislink signal.
    for (const card of cards) {
      if (!matched.some(m => m.code === card.code)) {
        mislinked.push({
          code: card.code, childName: card.childName, phone4: p4,
          fileHasChildren: [...new Set(csvRows.flatMap(r => r.participants || []))],
        });
      }
    }
    unmatchedRows.push(...csvRows.filter(r => !usedRowIdx.has(r)));
  }

  // Whole-system check, independent of this file: any card with no waiver date at all.
  const noWaiverOnFile = allCards
    .filter(c => !c.waiverSigned)
    .map(c => ({ code: c.code, childName: c.childName, phone4: c.phone4 || null }));

  const totals = {
    rowsInFile: rows.length,
    cardsUpdated: matched.filter(m => m.changed).length,
    cardsAlreadyCurrent: matched.filter(m => !m.changed).length,
    possibleMislinks: mislinked.length,
    rowsWithNoMatchingCard: unmatchedRows.length,
    cardsWithNoWaiverAtAll: noWaiverOnFile.length,
  };

  return json({ ok: true, dryRun, totals, matched, mislinked, noWaiverOnFile,
    unmatchedRows: unmatchedRows.slice(0, 50) });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/waiver-import" };
