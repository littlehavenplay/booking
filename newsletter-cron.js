// Scheduled every 15 minutes. Two jobs:
//   1) Any "scheduled" campaign whose time has arrived flips to "sending".
//   2) Any "sending" campaign gets its next batches delivered until complete.
// Progress is tracked on each campaign record, so runs are always safe to repeat.
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { STORE, sendCampaignBatch } from "./lib-newsletter.js";

const BATCHES_PER_RUN = 3; // up to 3×100 recipients per campaign per run

export default async () => {
  const store = getStore(STORE);
  const now = Date.now();
  const keys = await listAllKeys(store, { prefix: "campaign:" });

  let started = 0, sent = 0, completed = 0;

  for (const k of keys) {
    let c = null; try { c = await store.get(k, { type: "json" }); } catch {}
    if (!c) continue;

    if (c.status === "scheduled" && c.scheduledAt && Date.parse(c.scheduledAt) <= now) {
      c.status = "sending"; started++;
    }
    if (c.status !== "sending") continue;

    for (let i = 0; i < BATCHES_PER_RUN; i++) {
      const r = await sendCampaignBatch(store, c, { max: 100 });
      sent += r.processed;
      if (r.complete) { completed++; break; }
      if (r.processed === 0) break; // nothing sent (e.g. email misconfigured) — stop, retry next run
    }
    try { await store.setJSON(k, c); } catch {}
  }

  return new Response(JSON.stringify({ ok: true, started, sent, completed }),
    { status: 200, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "*/15 * * * *" };
