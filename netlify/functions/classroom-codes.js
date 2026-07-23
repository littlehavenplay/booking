// POST /api/classroom-codes  (admin key or staff PIN)
// Batch-generate "free child admission" codes for a classroom. Reuses the existing
// free-visit reward mechanism: each code makes ONE child's admission free at the
// correct current price (baby-room 6-17mo OR preschool 18mo+), single-use, and
// cannot be combined with other discounts. Codes are entered in the booking page's
// "Free-visit reward code" field.
//
// Body: { key, action:"generate", label, count, expiryDays? }
//        { key, action:"list", label? }        — list classroom codes (optionally by label)
import { getStore } from "@netlify/blobs";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,0,1 — easy to read/write
const DEFAULT_EXPIRY_DAYS = 30;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  const store = getStore("rewards");
  const action = (b.action || "generate").toString();

  if (action === "list") {
    const want = (b.label || "").toString().trim();
    let keys = [];
    try { const r = await store.list({ prefix: "reward:" }); keys = (r.blobs || []).map(x => x.key); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (const k of keys) {
      let rec = null; try { rec = await store.get(k, { type: "json" }); } catch {}
      if (!rec || rec.source !== "classroom") continue;
      if (want && (rec.classroom || "") !== want) continue;
      const expired = rec.expiry && rec.expiry < today;
      rows.push({
        code: rec.code, classroom: rec.classroom || "",
        status: rec.used ? "used" : expired ? "expired" : "active",
        issued: (rec.issuedAt || "").slice(0, 10), expiry: rec.expiry || "",
      });
    }
    rows.sort((a, c) => (c.issued || "").localeCompare(a.issued || ""));
    return json({ ok: true, rows });
  }

  if (action !== "generate") return json({ error: "Unknown action." }, 400);

  const label = (b.label || "").toString().trim().slice(0, 60);
  if (!label) return json({ error: "Enter a classroom name (e.g. \"Preschool Class\")." }, 400);
  let count = parseInt(b.count, 10);
  if (!Number.isFinite(count) || count < 1) return json({ error: "Enter how many codes to make (1–100)." }, 400);
  count = Math.min(count, 100);
  let expiryDays = parseInt(b.expiryDays, 10);
  if (!Number.isFinite(expiryDays) || expiryDays < 1) expiryDays = DEFAULT_EXPIRY_DAYS;
  expiryDays = Math.min(expiryDays, 365);

  const now = new Date();
  const expiry = new Date(now.getTime() + expiryDays * 86400000).toISOString().slice(0, 10);
  const codes = [];

  for (let n = 0; n < count; n++) {
    const code = await uniqueClassroomCode(store);
    const rec = {
      code, type: "free-visit", source: "classroom", classroom: label,
      issuedAt: now.toISOString(), expiry, used: false,
    };
    try { await store.setJSON("reward:" + code, rec); }
    catch { return json({ error: `Saved ${codes.length} of ${count} — storage hiccup, try again for the rest.`, codes }, 502); }
    codes.push(code);
  }

  return json({
    ok: true, label, expiry, count: codes.length, codes,
    message: `Generated ${codes.length} free-admission code${codes.length === 1 ? "" : "s"} for ${label}, valid through ${expiry}.`,
  });
};

async function uniqueClassroomCode(store) {
  for (let i = 0; i < 10; i++) {
    let s = "CLASS";
    for (let j = 0; j < 4; j++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    try { const e = await store.get("reward:" + s, { type: "json" }); if (!e) return s; } catch { return s; }
  }
  return "CLASS" + Date.now().toString(36).toUpperCase().slice(-5);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const config = { path: "/api/classroom-codes" };
