// Scheduled every 15 minutes. Drives every in-flight campaign one or more steps
// along the broadcast pipeline:
//
//   scheduled -> syncing -> ready -> queued -> sent
//
//   scheduled : waiting for its send time
//   syncing   : subscriber list being uploaded to Resend as Contacts
//   ready     : list is in place, broadcast about to be created and sent
//   queued    : Resend has it and is delivering
//   sent      : done
//
// Every step is idempotent and progress is written to the campaign record, so
// runs are always safe to repeat — a function that dies mid-flight simply
// resumes here. Nothing in this path touches the transactional email quota.
import { getStore } from "@netlify/blobs";
import { listAllKeys } from "./lib-blobs.js";
import { STORE, runCampaign } from "./lib-newsletter.js";
import { sendOwnerAlert } from "./lib-email.js";

const ACTIVE = new Set(["scheduled", "syncing", "ready", "queued"]);

export default async () => {
  const store = getStore(STORE);
  const keys = await listAllKeys(store, { prefix: "campaign:" });

  let advanced = 0, completed = 0, parked = 0;

  for (const k of keys) {
    let c = null; try { c = await store.get(k, { type: "json", consistency: "strong" }); } catch {}
    if (!c || !ACTIVE.has(c.status)) continue;

    // A cron run has more headroom than a button press, so allow a longer wait
    // for an import to land — but still bounded, so one stuck campaign can't
    // starve the others in this run.
    const { steps, last } = await runCampaign(store, c, { budgetMs: 8000, maxSteps: 10, key: k });
    if (steps) advanced++;
    if (last && last.done) completed++;

    // A campaign that has parked itself gets one owner alert, not a nightly one.
    if (c.status === "failed" && !c.errorAlerted) {
      parked++;
      c.errorAlerted = true;
      try {
        await sendOwnerAlert(
          `\u26A0\uFE0F Newsletter "${c.subject || "campaign"}" could not send`,
          `<h3>A newsletter campaign has stopped</h3>
           <p><b>${c.subject || "(no subject)"}</b><br>
           Subscribers on the list: ${(c.stats && c.stats.total) || 0}</p>
           <p><b>Reason:</b><br>${c.lastError || "unknown"}</p>
           <p>Nothing further will be sent for this campaign until you look at it.
           Open the Newsletter tool and use <b>Retry</b> once the cause is fixed.</p>`
        );
      } catch {}
      try { await store.setJSON(k, c); } catch {}
    }
  }

  return new Response(JSON.stringify({ ok: true, advanced, completed, parked }),
    { status: 200, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "*/15 * * * *" };
