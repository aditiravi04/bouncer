// Bridge between the FilterEntry domain model and the (FilterEntry-agnostic)
// share-code encoder. Kept separate from share-encoding.ts so that codec stays
// pure string[] in / string[] out and reusable in isolation.

import type { FilterEntry } from '../types';
import { buildFilterPackShareUrl, encodeFilterPackCode } from './share-encoding';

/** Build the shareable URL for one filter or a list of filters.
 *
 *  "Share this one" and "share all" are the SAME call — they differ only in
 *  whether you pass a single entry or the whole list. Only the `phrase` is
 *  shared; id/createdAt/sharedFrom stay local (see SharedFilterPack). Duplicate
 *  phrases are collapsed so "share all" never emits the same phrase twice. */
export async function buildFiltersShareUrl(
  entries: FilterEntry | FilterEntry[],
): Promise<string> {
  const list = Array.isArray(entries) ? entries : [entries];
  const phrases = [...new Set(list.map(e => e.phrase))];
  return buildFilterPackShareUrl(await encodeFilterPackCode({ phrases }));
}
