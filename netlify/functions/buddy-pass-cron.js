// Monthly buddy-pass issue: 1st of the month, 8:00 AM Pacific (15:00 UTC).
// Idempotent per membership per month, so a retry or an overlapping run can't
// issue a second set. Separate from buddy-pass.js because Netlify rejects a
// function that is both scheduled and reachable on a custom path.
import { issueAll, thisMonth } from "./lib-buddypass.js";

export default async () => {
  const out = await issueAll(thisMonth());
  return new Response(JSON.stringify({ ok: true, ranBy: "schedule", ...out }),
    { status: 200, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 15 1 * *" };
