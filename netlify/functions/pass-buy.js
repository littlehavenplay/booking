// POST /api/pass-buy — PERMANENTLY DISABLED.
// Legacy prepaid punch cards are discontinued. We no longer sell or reload them —
// families book regular admission or join the Play Club membership.
// This endpoint is kept only so any stale link hitting it gets a clear, honest
// answer instead of a broken purchase attempt.
export default async (req) => {
  return new Response(JSON.stringify({
    error: "Prepaid cards are no longer sold. Book a visit online, or see our Play Club membership.",
    redirect: "/book.html",
  }), { status: 410, headers: { "content-type": "application/json", "cache-control": "no-store" } });
};
export const config = { path: "/api/pass-buy" };
