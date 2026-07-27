// POST /api/pass-buy — PERMANENTLY DISABLED.
// Legacy prepaid punch cards are discontinued. We no longer sell or reload them —
// everyone is on the free Loyalty Punch Card program instead (pay normal admission
// each visit; every 8th visit is free automatically). See lib-loyalty.js.
// This endpoint is kept only so any stale link hitting it gets a clear, honest
// answer instead of a broken purchase attempt.
export default async (req) => {
  return new Response(JSON.stringify({
    error: "Punch cards are no longer sold or reloaded — that program has been retired. " +
      "You're on our free Loyalty Punch Card program instead: just book your visit online, " +
      "pay normal admission, and your 8th visit is on us automatically.",
    redirect: "/book.html",
  }), { status: 410, headers: { "content-type": "application/json", "cache-control": "no-store" } });
};
export const config = { path: "/api/pass-buy" };
