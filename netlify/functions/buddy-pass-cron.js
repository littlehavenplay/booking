// RETIRED (Oct 2026). Play Club buddy passes ended; members now get a
// complimentary snack + juice box each visit instead. No passes are issued.
// Kept as a harmless no-op so an upload that doesn't delete this file can't
// keep issuing passes. Safe to delete.
export default async () => new Response(JSON.stringify({ ok: true, retired: true }),
  { status: 200, headers: { "content-type": "application/json" } });
export const config = { schedule: "0 15 1 * *" };
