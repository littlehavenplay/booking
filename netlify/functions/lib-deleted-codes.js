// Permanently-deleted codes ("tombstones").
// When staff delete a code, we remember it here so that:
//   - the codes ledger never shows it again, even while storage catches up, and
//   - no tool can quietly bring it back.
// Stored in the "site" store under "deleted-codes" as { CODE: isoDate }.
import { getStore } from "@netlify/blobs";

const KEY = "deleted-codes";
function site() { return getStore({ name: "site", consistency: "strong" }); }
export function normCode(c) { return (c || "").toString().trim().toUpperCase(); }

export async function getDeletedCodes() {
  try { return (await site().get(KEY, { type: "json" })) || {}; } catch { return {}; }
}
export async function isDeletedCode(code) {
  const m = await getDeletedCodes();
  const c = normCode(code);
  return !!(m[c] || m[c.replace(/[^A-Z0-9]/g, "")]);
}
export async function markDeleted(code) {
  const m = await getDeletedCodes();
  m[normCode(code)] = new Date().toISOString();
  try { await site().setJSON(KEY, m); } catch {}
}
export async function unmarkDeleted(code) {
  const m = await getDeletedCodes();
  const c = normCode(code);
  if (!m[c]) return;
  delete m[c];
  try { await site().setJSON(KEY, m); } catch {}
}
