// POST /api/famcode  (ADMIN KEY ONLY — never the staff PIN)
//
// The owner's family master code. One active code at a time. When used on the
// booking page it zeroes the entire admission total regardless of headcount,
// never expires, and can be used any number of times.
//
// This is the single most powerful object in the system: anyone holding the code
// can book free play forever. Everything here exists to contain that risk —
// admin-only access, a random unguessable code, a cap on children per booking,
// an owner alert on every use, and a full usage log.
//
// Body:
//   { key, action:"get" }                    -> current code, settings, recent uses
//   { key, action:"rotate", note }           -> new random code; the old one dies at once
//   { key, action:"update", maxChildren, notifyEmail, active }
//   { key, action:"log", limit }             -> usage history
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";

const STORE = "famcode";
const CURRENT = "current";
const DEFAULT_MAX_CHILDREN = 6;      // one hour's capacity

// Ambiguous characters (0/O, 1/I/L) left out so it can be read aloud or typed
// from a screenshot without mistakes.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomBlock(n) {
  let s = "";
  const bytes = new Uint8Array(n);
  (globalThis.crypto || require("node:crypto").webcrypto).getRandomValues(bytes);
  for (let i = 0; i < n; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

export function newFamCode() {
  return "FAM" + randomBlock(4) + randomBlock(4);
}

// Shared with book.js so there is exactly one definition of "is this the family
// code" — a second copy would eventually drift and either stop working or, far
// worse, keep honouring a rotated code.
export async function getActiveFamCode() {
  try {
    const rec = await getStore(STORE).get(CURRENT, { type: "json" });
    if (!rec || rec.active === false || !rec.code) return null;
    return rec;
  } catch { return null; }
}

export async function logFamUse(entry) {
  try {
    const store = getStore(STORE);
    const at = new Date().toISOString();
    await store.setJSON("use:" + at + ":" + Math.random().toString(36).slice(2, 7), { at, ...entry });
    const rec = await store.get(CURRENT, { type: "json" });
    if (rec) {
      rec.useCount = (rec.useCount || 0) + 1;
      rec.lastUsedAt = at;
      await store.setJSON(CURRENT, rec);
    }
  } catch {}
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  // Admin key only. The staff PIN deliberately does NOT open this — a code that
  // zeroes any booking forever shouldn't be reachable from the front desk.
  const adminKey = process.env.ADMIN_KEY || "";
  if (!adminKey) return json({ error: "Admin key isn't configured." }, 500);
  if ((b.key || "").toString() !== adminKey) return json({ error: "Admin key required." }, 401);

  const store = getStore(STORE);
  const action = (b.action || "get").toString();

  async function recentUses(limit = 40) {
    const out = [];
    try {
      const keys = (await listAllKeys(store, { prefix: "use:" })).sort().reverse().slice(0, limit);
      for (const k of keys) {
        try { const u = await store.get(k, { type: "json" }); if (u) out.push(u); } catch {}
      }
    } catch {}
    return out;
  }

  if (action === "get" || action === "log") {
    let rec = null;
    try { rec = await store.get(CURRENT, { type: "json" }); } catch {}
    return json({ ok: true, code: rec || null, uses: await recentUses(action === "log" ? 100 : 20) });
  }

  if (action === "rotate") {
    let prev = null;
    try { prev = await store.get(CURRENT, { type: "json" }); } catch {}
    const rec = {
      code: newFamCode(),
      active: true,
      maxChildren: Number(b.maxChildren) > 0 ? Math.min(20, Number(b.maxChildren))
                  : (prev?.maxChildren || DEFAULT_MAX_CHILDREN),
      notifyEmail: (b.notifyEmail || prev?.notifyEmail || "").toString().trim(),
      note: (b.note || "").toString().slice(0, 120),
      createdAt: new Date().toISOString(),
      useCount: 0,
      previousCode: prev?.code || null,
      // Kept only so the booking page can say "that code was replaced" instead of
      // the blank "not found" that would have you hunting for a bug.
      retiredAt: prev ? new Date().toISOString() : null,
    };
    try { await store.setJSON(CURRENT, rec); }
    catch { return json({ error: "Couldn't save the new code. Try again." }, 502); }
    return json({ ok: true, code: rec, replaced: prev?.code || null,
      message: prev ? `New code ${rec.code} is live. ${prev.code} stopped working immediately.`
                    : `Family code ${rec.code} created.` });
  }

  if (action === "update") {
    let rec = null;
    try { rec = await store.get(CURRENT, { type: "json" }); } catch {}
    if (!rec) return json({ error: "No family code yet — create one first." }, 404);
    if (b.maxChildren != null) rec.maxChildren = Math.max(1, Math.min(20, Number(b.maxChildren) || DEFAULT_MAX_CHILDREN));
    if (b.notifyEmail != null) rec.notifyEmail = (b.notifyEmail || "").toString().trim();
    if (b.active != null) rec.active = !!b.active;
    if (b.note != null) rec.note = (b.note || "").toString().slice(0, 120);
    try { await store.setJSON(CURRENT, rec); }
    catch { return json({ error: "Couldn't save. Try again." }, 502); }
    return json({ ok: true, code: rec, message: "Saved." });
  }

  return json({ error: "Unknown action." }, 400);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export const config = { path: "/api/famcode" };
