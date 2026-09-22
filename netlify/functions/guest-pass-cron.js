// RETIRED (Sept 2026) — replaced by buddy passes (buddy-pass-cron.js).
// Kept as a harmless no-op so an upload that doesn't delete this file can't
// keep issuing the old guest passes alongside the new ones. Safe to delete.
export default async () => new Response(JSON.stringify({ ok: true, retired: true, replacedBy: "buddy-pass-cron" }),
  { status: 200, headers: { "content-type": "application/json" } });
export const config = { schedule: "0 15 1 * *" };
