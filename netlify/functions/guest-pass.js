// RETIRED (Sept 2026) — replaced by /api/buddy-pass.
// The old endpoint let staff spend a pass at the desk with no member present,
// which the buddy-pass rules forbid. It now refuses everything. Safe to delete.
export default async () => new Response(JSON.stringify({
  ok: false, retired: true,
  error: "Guest passes have been replaced by buddy passes, which are redeemed online with the member's booking.",
}), { status: 410, headers: { "content-type": "application/json" } });
export const config = { path: "/api/guest-pass" };
