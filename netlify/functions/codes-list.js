// POST /api/codes-list  (admin key or staff PIN)
// One combined ledger of every code the studio has issued:
//   - store credits    (blob store "credits", prefix "credit:")
//   - discount codes   (blob store "discounts", prefix "disc:")
//   - punch cards      (blob store "passes", prefix "pass:")
//   - free-visit codes (blob store "rewards", prefix "reward:") — loyalty 8th-visit
//     rewards, birthday gift codes, and classroom codes all live here.
// Returns a normalized list so the admin/staff pages can render one table.
// Body: { key, filter? }   filter = "all" | "credit" | "discount" | "pass" | "reward" (optional)
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const today = new Date().toISOString().slice(0, 10);
  const want = (b.filter || "all").toString();
  const rows = [];

  // ---- Store credits ----
  if (want === "all" || want === "credit") {
    const store = getStore("credits");
    let keys = [];
    keys = await listAllKeys(store, { prefix: "credit:" });
    for (const k of keys) {
      let r = null; try { r = await store.get(k, { type: "json" }); } catch {}
      if (!r || !r.code) continue;
      const expired = r.expiry && r.expiry < today;
      const status = (r.active === false) ? "used" : expired ? "expired" : ((r.amount || 0) < 1 ? "usedup" : "active");
      rows.push({
        type: "credit",
        typeLabel: (r.type === "courtesy") ? "Courtesy credit" : "Store credit",
        code: r.code,
        value: money(r.amount), valueRaw: (r.amount || 0),
        original: money(r.original != null ? r.original : r.amount),
        status,
        issued: dateOnly(r.createdAt),
        expiry: r.expiry || "",
        name: r.custName || "",
        email: r.email || "",
        note: r.reason || "",
      });
    }
  }

  // ---- Discount codes ----
  if (want === "all" || want === "discount") {
    const store = getStore("discounts");
    let keys = [];
    keys = await listAllKeys(store, { prefix: "disc:" });
    for (const k of keys) {
      let r = null; try { r = await store.get(k, { type: "json" }); } catch {}
      if (!r || !r.code) continue;
      const expired = r.expiry && r.expiry < today;
      const status = (r.active === false) ? "deactivated" : r.used ? "used" : expired ? "expired" : "active";
      rows.push({
        type: "discount",
        typeLabel: "Discount code",
        code: r.code,
        value: (r.percent != null ? r.percent + "% off" : ""), valueRaw: (r.percent || 0),
        original: (r.percent != null ? r.percent + "% off" : ""),
        status,
        issued: dateOnly(r.createdAt),
        expiry: r.expiry || "",
        name: r.name || "",
        email: r.email || "",
        note: r.label || "",
      });
    }
  }

  // ---- Punch cards ----
  if (want === "all" || want === "pass") {
    const store = getStore("passes");
    let keys = [];
    keys = await listAllKeys(store, { prefix: "pass:" });
    for (const k of keys) {
      let r = null; try { r = await store.get(k, { type: "json" }); } catch {}
      if (!r || !r.code) continue;
      const expired = r.expiry && r.expiry < today;
      const usedUp = (r.visitsRemaining || 0) < 1;
      const status = (r.active === false) ? "deactivated" : expired ? "expired" : usedUp ? "usedup" : "active";
      rows.push({
        type: "pass",
        typeLabel: (r.visits === 5 || r.visits === 10) ? "Punch card (legacy)" : "Punch card",
        code: r.code,
        value: (r.visitsRemaining || 0) + " / " + (r.visits || 0) + " visits", valueRaw: (r.visitsRemaining || 0),
        original: (r.visits || 0) + " visits",
        status,
        issued: dateOnly(r.purchaseDate || r.createdAt),
        expiry: r.expiry || "",
        name: r.buyerName || r.childName || "",
        email: r.buyerEmail || "",
        note: r.label || r.admission || "",
      });
    }
  }

  // ---- Free-visit codes: loyalty 8th-visit rewards, birthday gifts, classroom codes ----
  if (want === "all" || want === "reward") {
    const store = getStore("rewards");
    let keys = [];
    keys = await listAllKeys(store, { prefix: "reward:" });
    for (const k of keys) {
      let r = null; try { r = await store.get(k, { type: "json" }); } catch {}
      if (!r || !r.code) continue;
      const expired = r.expiry && r.expiry < today;
      const status = r.used ? "used" : expired ? "expired" : "active";
      const kindLabel = r.source === "classroom" ? `Classroom code (${r.classroom || "—"})`
        : r.kind === "birthday" ? "Birthday gift" : "Loyalty free visit";
      rows.push({
        type: "reward",
        typeLabel: kindLabel,
        code: r.code,
        value: "1 free admission", valueRaw: 1,
        original: "1 free admission",
        status,
        issued: dateOnly(r.issuedAt),
        expiry: r.expiry || "",
        name: r.childName || "",
        email: r.usedBy || "",
        note: r.loyaltyCode ? ("linked to " + r.loyaltyCode) : "",
      });
    }
  }

  // Newest issued first; blanks sort last.
  rows.sort((a, c) => (c.issued || "").localeCompare(a.issued || ""));

  const counts = { total: rows.length, active: 0, expired: 0, used: 0, deactivated: 0, usedup: 0 };
  rows.forEach(r => { if (counts[r.status] != null) counts[r.status]++; });

  return json({ ok: true, rows, counts, today });
};

function money(cents) { return "$" + (((cents || 0)) / 100).toFixed(2); }
function dateOnly(v) { return v ? v.toString().slice(0, 10) : ""; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/codes-list" };
