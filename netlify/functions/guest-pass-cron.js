// Monthly guest-pass issuing run — 1st of the month at 15:00 UTC.
//
// Separate from guest-pass.js on purpose: Netlify rejects a function that is
// both scheduled and reachable on a custom path, so the schedule lives here and
// the staff endpoint lives there. Both call the same issueAll().
//
// Issuance is idempotent per membership per month, so an extra run — a retry, a
// manual trigger, two invocations overlapping — cannot hand out a second set.

import { issueAll, monthKey } from "./lib-guestpass.js";

export default async () => {
  const out = await issueAll(monthKey());
  return new Response(JSON.stringify({ ok: true, ranBy: "schedule", ...out }),
    { status: 200, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 15 1 * *" };
