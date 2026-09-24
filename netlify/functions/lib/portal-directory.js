import { getStore } from '@netlify/blobs';

// The customer directory the portal draws, as one stored answer that is kept up to date rather
// than thrown away.
//
// Opening the portal used to fetch three things: the customer records, every prompt set on the
// platform, and a summary of every customer's audit history. The last two existed to render two
// badges per row — "approved on <date>" and "N runs". All three are a listing followed by one read
// per blob, so a thousand customers cost a couple of thousand network round trips to draw a list
// you are about to click one row of.
//
// Storing the answer fixed the read and moved the problem: any write dropped it, and the next
// person to open the portal paid to rebuild it — reading every customer and every prompt set.
// A page load must never do that. Opening the front page is one read whether there is one customer
// or ten thousand, and it stays that way because writes PATCH this rather than discard it: a
// customer change rewrites one entry, a finished run rewrites one entry, and neither is a function
// of how many other customers exist.
//
// It is still only a cache. The customer records, prompt sets and result rows remain the source of
// truth, and a full build from them is available for the first ever load and for repair.

const STORE = 'hieronymus-portal-index';
const KEY = 'directory';

/** The stored directory, or null when there has never been one. One read. */
export async function readDirectory() {
  try {
    const rec = await getStore(STORE).get(KEY, { type: 'json' });
    return rec && Array.isArray(rec.items) ? rec : null;
  } catch (e) {
    return null;
  }
}

export async function writeDirectory(items) {
  const rec = { builtAt: new Date().toISOString(), items };
  try { await getStore(STORE).setJSON(KEY, rec); } catch (e) {
    console.error('PORTAL_DIRECTORY_WRITE_FAILED', e && e.message);
  }
  return rec;
}

/**
 * Replaces one customer's entry, keeping everything else untouched. Two operations, whatever the
 * customer count — which is the whole point, and the reason writes no longer drop the directory.
 *
 * `merge` receives the existing entry, if there is one, so a caller that only knows about badges
 * does not have to know about the customer record, and vice versa.
 */
export async function patchDirectoryEntry(matches, merge) {
  const rec = await readDirectory();
  // Nothing stored yet: the first full build will include this. Writing a directory of one here
  // would produce a list that is missing every other customer.
  if (!rec) return false;

  const i = rec.items.findIndex(matches);
  const next = merge(i === -1 ? null : rec.items[i]);
  if (!next) return false;

  if (i === -1) rec.items.unshift(next); else rec.items[i] = next;
  await writeDirectory(rec.items);
  return true;
}

/** Drops one customer from the list. Two operations. */
export async function removeDirectoryEntry(matches) {
  const rec = await readDirectory();
  if (!rec) return false;
  const kept = rec.items.filter(item => !matches(item));
  if (kept.length === rec.items.length) return false;
  await writeDirectory(kept);
  return true;
}

/**
 * Throws the directory away entirely, forcing a full rebuild on the next read.
 *
 * Deliberately not called by ordinary writes — they patch. This is for the cases where the stored
 * list genuinely cannot be trusted to be repairable in place, and it accepts that whoever reads
 * next pays for it.
 */
export async function invalidateDirectory() {
  try { await getStore(STORE).delete(KEY); } catch (e) {
    console.error('PORTAL_DIRECTORY_INVALIDATE_FAILED', e && e.message);
  }
}
