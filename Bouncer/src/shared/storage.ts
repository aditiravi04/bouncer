import type {
  DescriptionKey,
  FilterEntry,
  SiteId,
  StorageSchema,
} from '../types';

/** Typed wrapper around chrome.storage.local.get(). Values may be undefined if not yet set. */
export async function getStorage<K extends keyof StorageSchema>(
  keys: K[]
): Promise<Partial<Pick<StorageSchema, K>>> {
  return chrome.storage.local.get(keys);
}

/** Typed wrapper around chrome.storage.local.set(). */
export async function setStorage(
  items: Partial<StorageSchema>
): Promise<void> {
  await chrome.storage.local.set(items);
}

/** Typed wrapper around chrome.storage.local.remove(). */
export async function removeStorage<K extends keyof StorageSchema>(
  keys: K | K[]
): Promise<void> {
  await chrome.storage.local.remove(keys);
}

function siteIdFromDescKey(key: DescriptionKey): SiteId {
  return key.slice('descriptions_'.length) as SiteId;
}

function descriptionsKeyFor(siteId: SiteId): DescriptionKey {
  return `descriptions_${siteId}`;
}

/** Build a fresh FilterEntry from a bare phrase. id (crypto.randomUUID) and
 *  createdAt are assigned here so every entry gets stable identity the moment
 *  it enters storage — and exactly once. */
function makeFilterEntry(phrase: string, sharedFrom?: string): FilterEntry {
  return {
    id: crypto.randomUUID(),
    phrase,
    createdAt: Date.now(),
    ...(sharedFrom ? { sharedFrom } : {}),
  };
}

/** True when a stored list item is the new object shape rather than a legacy
 *  bare string. */
function isFilterEntry(v: unknown): v is FilterEntry {
  return typeof v === 'object' && v !== null
    && typeof (v as FilterEntry).phrase === 'string';
}

async function loadMainList(siteId: SiteId): Promise<FilterEntry[]> {
  const descKey = descriptionsKeyFor(siteId);
  // Use untyped get for legacy migration keys that are no longer in StorageSchema.
  const data = await chrome.storage.local.get([
    descKey,
    `filterPacks_${siteId}`,
    `activeFilterPack_${siteId}`,
    `activeFilterPacks_${siteId}`,
  ]);

  const legacyActiveSet = data[`activeFilterPacks_${siteId}`];
  if (Array.isArray(legacyActiveSet)) {
    const packs = (data[`filterPacks_${siteId}`] as Record<string, string[]> | undefined) ?? {};
    const seedNames = (legacyActiveSet as unknown[]).filter(
      (n): n is string => typeof n === 'string' && Boolean(packs[n])
    );
    const seen = new Set<string>();
    const mainList: FilterEntry[] = [];
    for (const n of seedNames) {
      for (const p of packs[n] || []) {
        if (!seen.has(p)) { seen.add(p); mainList.push(makeFilterEntry(p)); }
      }
    }
    await chrome.storage.local.set({ [descKey]: mainList });
    await chrome.storage.local.remove([`activeFilterPack_${siteId}`, `activeFilterPacks_${siteId}`]);
    return mainList;
  }

  const raw = data[descKey];
  if (!Array.isArray(raw)) return [];

  // Normalize every item to a FilterEntry: keep existing objects as-is, and
  // convert legacy bare strings. Persist once (only if we actually upgraded
  // a string) so ids/timestamps are assigned a single time, never per-read.
  let mutated = false;
  const entries: FilterEntry[] = [];
  for (const item of raw as unknown[]) {
    if (isFilterEntry(item)) {
      entries.push(item);
    } else if (typeof item === 'string') {
      entries.push(makeFilterEntry(item));
      mutated = true;
    }
    // anything else (null, number, …) is dropped
  }
  if (mutated) await chrome.storage.local.set({ [descKey]: entries });
  return entries;
}

/** Canonical getter — the full FilterEntry objects (id, phrase, createdAt, sharedFrom). */
export async function getFilterEntries(descriptionsKey: DescriptionKey): Promise<FilterEntry[]> {
  return loadMainList(siteIdFromDescKey(descriptionsKey));
}

/** Phrase-only view, for the classifier and any caller that just needs the text. */
export async function getDescriptions(descriptionsKey: DescriptionKey): Promise<string[]> {
  return (await getFilterEntries(descriptionsKey)).map(e => e.phrase);
}

/** Canonical writer — persists the full FilterEntry list as-is. */
export async function setFilterEntries(
  descriptionsKey: DescriptionKey,
  entries: FilterEntry[],
): Promise<void> {
  await chrome.storage.local.set({ [descriptionsKey]: entries });
}

/** Remove a single entry by id; returns the updated list. */
export async function deleteFilterEntryById(
  descriptionsKey: DescriptionKey,
  id: string,
): Promise<FilterEntry[]> {
  const entries = (await getFilterEntries(descriptionsKey)).filter(e => e.id !== id);
  await setFilterEntries(descriptionsKey, entries);
  return entries;
}

/** How long a pending shared-filter handoff stays valid. If the user doesn't
 *  sign in / activate within this window of clicking the link (or of installing),
 *  the handoff expires and no prompt is shown. */
export const PENDING_IMPORT_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Hand off a shared filter code from the silent landing page to the x.com
 *  content script (which shows the "Apply this filter?" prompt). Stamps the
 *  time so a stale handoff can expire. */
export async function setPendingImport(code: string): Promise<void> {
  await chrome.storage.local.set({ pendingImport: code, pendingImportAt: Date.now() });
}

/** Read the pending shared code, if any and still fresh. A handoff older than
 *  PENDING_IMPORT_TTL_MS is treated as expired: it's cleared and undefined is
 *  returned, so the "Apply this filter?" prompt never fires for a stale link. */
export async function getPendingImport(): Promise<string | undefined> {
  const data = await chrome.storage.local.get(['pendingImport', 'pendingImportAt']);
  const code = data.pendingImport;
  if (typeof code !== 'string' || !code) return undefined;
  const ts = typeof data.pendingImportAt === 'number' ? data.pendingImportAt : 0;
  if (Date.now() - ts > PENDING_IMPORT_TTL_MS) {
    await clearPendingImport();
    return undefined;
  }
  return code;
}

/** Clear the pending code + timestamp (one-shot: on prompt shown, or on expiry). */
export async function clearPendingImport(): Promise<void> {
  await chrome.storage.local.remove(['pendingImport', 'pendingImportAt']);
}

/** Import phrases into a list: append any not already present (matched by phrase
 *  text) as fresh FilterEntry objects tagged with `sharedFrom`. Deduplicates
 *  against the existing list AND within `phrases`. One write. Returns the number
 *  actually added (0 when every phrase was already present). */
export async function addImportedPhrases(
  descriptionsKey: DescriptionKey,
  phrases: string[],
  sharedFrom?: string,
): Promise<number> {
  const existing = await getFilterEntries(descriptionsKey);
  const have = new Set(existing.map(e => e.phrase));
  const additions: FilterEntry[] = [];
  for (const phrase of phrases) {
    if (have.has(phrase)) continue;
    have.add(phrase);
    additions.push(makeFilterEntry(phrase, sharedFrom));
  }
  if (additions.length === 0) return 0;
  await setFilterEntries(descriptionsKey, [...existing, ...additions]);
  return additions.length;
}

/** Compatibility writer for callers that only have phrase strings (the one-time
 *  sync→local migration; whole-list UI saves not yet refactored to entries).
 *  Reconciles each phrase against the existing list so an unchanged phrase keeps
 *  its id/createdAt/sharedFrom; new phrases get a fresh entry. This is the ONLY
 *  write path that still matches by text — prefer the id-based functions above
 *  for the share/delete features. */
export async function setDescriptions(
  descriptionsKey: DescriptionKey,
  phrases: string[],
): Promise<void> {
  const existing = await getFilterEntries(descriptionsKey);
  const byPhrase = new Map(existing.map(e => [e.phrase, e]));
  const used = new Set<string>();
  const entries = phrases.map(phrase => {
    const prior = byPhrase.get(phrase);
    if (prior && !used.has(prior.id)) { used.add(prior.id); return prior; }
    return makeFilterEntry(phrase);
  });
  await setFilterEntries(descriptionsKey, entries);
}

// Default confidence threshold for the AI-text-detection worker. The worker
// returns a score in [0, 1]; posts at or above the active threshold are
// classified as AI-generated.
export const DEFAULT_AI_TEXT_DETECTION_THRESHOLD = 0.7;

// Default confidence threshold for the AI-image-detection worker. The worker
// returns a per-image score in [0, 1]; posts whose max score is at or above
// the active threshold are classified as AI-generated.
export const DEFAULT_AI_IMAGE_DETECTION_THRESHOLD = 0.7;

/** Clamp a stored threshold to [0, 1] and fall back to the default for missing/non-finite values. */
export function clampThreshold(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_AI_TEXT_DETECTION_THRESHOLD;
  return Math.min(1, Math.max(0, v));
}

/** Same as clampThreshold but with the image-detector default. */
export function clampImageThreshold(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_AI_IMAGE_DETECTION_THRESHOLD;
  return Math.min(1, Math.max(0, v));
}
