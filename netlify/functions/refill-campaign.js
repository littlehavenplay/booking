// Runs weekly only to catch any legacy punch-card holder whose card has just run out,
// and send them a ONE-TIME grandfather note (each holder emailed once, ever). Stops for
// anyone who refills or unsubscribes. It never re-emails someone who already got the note.
import { runRefillCampaign } from "./lib-refill.js";

export default async () => {
  const summary = await runRefillCampaign();
  return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
};
// Mondays at ~10am Pacific (17:00 UTC).
export const config = { schedule: "0 17 * * 1" };
