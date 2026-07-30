// Shared helper: list EVERY key under a prefix in a Netlify Blobs store, looping
// through pagination cursors instead of silently stopping at the first page.
// Netlify Blobs' store.list() only returns one page of results per call — for
// any store that can grow past that page size (which several of ours can, over
// months/years of daily use), a single un-paginated call quietly undercounts
// with no error. Use this anywhere completeness actually matters (financial
// reports, ledgers) rather than calling store.list() directly.
export async function listAllKeys(store, opts = {}) {
  let keys = [];
  try {
    let cursor = undefined;
    do {
      const r = await store.list(cursor ? { ...opts, cursor } : { ...opts });
      keys = keys.concat((r.blobs || []).map(x => x.key));
      cursor = r.cursor;
    } while (cursor);
  } catch { /* return whatever was collected before the failure */ }
  return keys;
}
