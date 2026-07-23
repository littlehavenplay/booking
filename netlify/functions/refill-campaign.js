// Scheduled weekly: emails customers whose punch cards are completely used up,
// reminding them to refill. Stops automatically once they buy another card or unsubscribe.
import { runRefillCampaign } from "./lib-refill.js";

export default async () => {
  const summary = await runRefillCampaign();
  return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
};
// Mondays at ~10am Pacific (17:00 UTC).
export const config = { schedule: "0 17 * * 1" };
