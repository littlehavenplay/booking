// POST /api/code-manage  (admin key or staff PIN)
// Deactivate or permanently delete any site-issued code — store credit, discount,
// punch card, or free-visit code (loyalty/birthday/classroom).
// Body: { key, action:"deactivate"|"delete", code }
// (Gift cards are managed in Square, not here.)
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { markDeleted } from "./lib-deleted-codes.js";

const TYPES = [
  { store: "credits",   prefix: "credit:", label: "store credit" },
  { store: "discounts", prefix: "disc:",   label: "discount code" },
  { store: "passes",    prefix: "pass:",   label: "punch card" },
  { store: "rewards",   prefix: "reward:", label: "free-visit code" },
];

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const action = (b.action || "").toString();
  if (action !== "deactivate" && action !== "delete") return json({ error: "Unknown action." }, 400);
  const code = (b.code || "").toString().trim().toUpperCase();
  if (!code) return json({ error: "Enter a code." }, 400);

  // DELETE: remove EVERY copy of this code in every store (matching the stored
  // key or the code on the record, any letter case), then remember it as
  // deleted so it can never reappear in the list or be brought back.
  if (action === "delete") {
    const removed = [];
    for (const t of TYPES) {
      const store = getStore({ name: t.store, consistency: "strong" });
      const keys = await listAllKeys(store, { prefix: t.prefix });
      for (const k of keys) {
        const suffix = k.slice(t.prefix.length).trim().toUpperCase();
        let match = suffix === code;
        if (!match) {
          let rec = null; try { rec = await store.get(k, { type: "json" }); } catch {}
          match = !!(rec && (rec.code || "").toString().trim().toUpperCase() === code);
        }
        if (!match) continue;
        try { await store.delete(k); removed.push(t.label); }
        catch { return json({ error: "Couldn't delete that code. Try again." }, 502); }
      }
    }
    await markDeleted(code);
    if (!removed.length) return json({ ok: true, action: "delete", code, message: `${code} is deleted.` });
    return json({ ok: true, action: "delete", kind: removed[0], code, message: `Deleted ${code}.` });
  }

  for (const t of TYPES) {
    const store = getStore({ name: t.store, consistency: "strong" });
    let rec = null;
    try { rec = await store.get(t.prefix + code, { type: "json" }); } catch {}
    if (!rec) continue;

    // deactivate — free-visit codes don't have an "active" flag, they use "used";
    // marking one used has the same practical effect (it can no longer be redeemed).
    if (t.store === "rewards") {
      if (rec.used) return json({ ok: true, action: "deactivate", kind: t.label, code, already: true, message: `${cap(t.label)} ${code} was already unusable.` });
      rec.used = true; rec.usedAt = new Date().toISOString(); rec.usedBy = "manually deactivated";
      try { await store.setJSON(t.prefix + code, rec); }
      catch { return json({ error: "Couldn't deactivate that code. Try again." }, 502); }
      return json({ ok: true, action: "deactivate", kind: t.label, code, message: `Deactivated ${t.label} ${code}. It can no longer be redeemed.` });
    }

    if (rec.active === false) return json({ ok: true, action: "deactivate", kind: t.label, code, already: true, message: `${cap(t.label)} ${code} was already deactivated.` });
    rec.active = false;
    rec.deactivatedAt = new Date().toISOString();
    try { await store.setJSON(t.prefix + code, rec); }
    catch { return json({ error: "Couldn't deactivate that code. Try again." }, 502); }
    return json({ ok: true, action: "deactivate", kind: t.label, code, message: `Deactivated ${t.label} ${code}. It can no longer be redeemed.` });
  }

  return json({ ok: false, error: "That code wasn't found among store credits, discount codes, punch cards, or free-visit codes. (Gift cards are managed in Square.)" }, 404);
};

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/code-manage" };
