// RETIRED (Oct 2026). Play Club buddy passes ended; members now get a
// complimentary snack + juice box each visit instead. Safe to delete.
export default async () => new Response(JSON.stringify({
  ok: false, retired: true, error: "Buddy passes have ended.",
}), { status: 410, headers: { "content-type": "application/json" } });
export const config = { path: "/api/buddy-pass" };
