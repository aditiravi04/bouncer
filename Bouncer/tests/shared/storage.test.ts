import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDescriptions,
  getFilterEntries,
  setFilterEntries,
  setDescriptions,
  deleteFilterEntryById,
  addImportedPhrases,
  setPendingImport,
  getPendingImport,
  clearPendingImport,
  PENDING_IMPORT_TTL_MS,
} from '../../src/shared/storage.js';
import type { FilterEntry } from '../../src/types.js';

const KEY = 'descriptions_twitter' as const;

// In-memory chrome.storage.local so set() actually persists and we can assert
// what migration wrote back. Replaces the static vi.fn() mock from setup.ts.
let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis.chrome as unknown as { storage: { local: unknown } }).storage.local = {
    get: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
  };
});

describe('loadMainList migration', () => {
  it('migrates a legacy flat string[] into FilterEntry[]', async () => {
    store[KEY] = ['politics', 'memes', 'technology'];

    const entries = await getFilterEntries(KEY);

    expect(entries.map(e => e.phrase)).toEqual(['politics', 'memes', 'technology']);
    for (const e of entries) {
      expect(typeof e.id).toBe('string');
      expect(e.id.length).toBeGreaterThan(0);
      expect(typeof e.createdAt).toBe('number');
      expect(e.sharedFrom).toBeUndefined();
    }
    // Upgraded shape is persisted back.
    expect(store[KEY]).toEqual(entries);
  });

  it('assigns ids exactly once — second read returns identical ids', async () => {
    store[KEY] = ['crypto'];

    const first = await getFilterEntries(KEY);
    const second = await getFilterEntries(KEY);

    expect(second[0].id).toBe(first[0].id);
    expect(second[0].createdAt).toBe(first[0].createdAt);
  });

  it('passes new FilterEntry[] through unchanged and does not rewrite storage', async () => {
    const existing: FilterEntry[] = [
      { id: 'fixed-id-1', phrase: 'spam', createdAt: 111 },
      { id: 'fixed-id-2', phrase: 'ads', createdAt: 222, sharedFrom: 'bncr2_abc' },
    ];
    store[KEY] = existing;

    const entries = await getFilterEntries(KEY);

    expect(entries).toEqual(existing);
    expect(store[KEY]).toBe(existing); // same reference: no rewrite happened
  });

  it('upgrades a mixed array, keeping existing entries and converting strings', async () => {
    store[KEY] = [
      { id: 'keep-me', phrase: 'kept', createdAt: 5 },
      'legacy-string',
    ];

    const entries = await getFilterEntries(KEY);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ id: 'keep-me', phrase: 'kept', createdAt: 5 });
    expect(entries[1].phrase).toBe('legacy-string');
    expect(entries[1].id).not.toBe('keep-me');
  });

  it('returns [] for an unset key', async () => {
    expect(await getFilterEntries(KEY)).toEqual([]);
  });

  it('migrates the legacy activeFilterPacks format into FilterEntry[]', async () => {
    store['filterPacks_twitter'] = { packA: ['a', 'b'], packB: ['b', 'c'] };
    store['activeFilterPacks_twitter'] = ['packA', 'packB'];

    const entries = await getFilterEntries(KEY);

    // Deduped union, in pack/phrase order.
    expect(entries.map(e => e.phrase)).toEqual(['a', 'b', 'c']);
    expect(store['activeFilterPacks_twitter']).toBeUndefined(); // legacy keys cleaned up
  });
});

describe('getDescriptions (phrase projection)', () => {
  it('returns just the phrase strings', async () => {
    store[KEY] = [
      { id: '1', phrase: 'one', createdAt: 1 },
      { id: '2', phrase: 'two', createdAt: 2 },
    ];
    expect(await getDescriptions(KEY)).toEqual(['one', 'two']);
  });
});

describe('deleteFilterEntryById', () => {
  it('removes exactly the entry with the matching id, even with duplicate phrases', async () => {
    store[KEY] = [
      { id: 'a', phrase: 'dup', createdAt: 1 },
      { id: 'b', phrase: 'dup', createdAt: 2 },
      { id: 'c', phrase: 'other', createdAt: 3 },
    ];

    const remaining = await deleteFilterEntryById(KEY, 'a');

    expect(remaining.map(e => e.id)).toEqual(['b', 'c']);
    expect(store[KEY]).toEqual(remaining);
  });

  it('is a no-op when the id is absent', async () => {
    store[KEY] = [{ id: 'a', phrase: 'x', createdAt: 1 }];
    const remaining = await deleteFilterEntryById(KEY, 'nope');
    expect(remaining.map(e => e.id)).toEqual(['a']);
  });
});

describe('setDescriptions (reconciling shim)', () => {
  it('keeps ids for unchanged phrases and mints ids for new ones', async () => {
    store[KEY] = [
      { id: 'keep-a', phrase: 'a', createdAt: 1 },
      { id: 'keep-b', phrase: 'b', createdAt: 2 },
    ];

    await setDescriptions(KEY, ['a', 'c']); // keep a, drop b, add c

    const entries = store[KEY] as FilterEntry[];
    expect(entries.map(e => e.phrase)).toEqual(['a', 'c']);
    expect(entries[0].id).toBe('keep-a'); // identity preserved
    expect(entries[1].id).not.toBe('keep-b'); // 'c' is genuinely new
  });

  it('gives duplicate phrases distinct entries rather than colliding on one id', async () => {
    store[KEY] = [{ id: 'keep-a', phrase: 'a', createdAt: 1 }];

    await setDescriptions(KEY, ['a', 'a']);

    const entries = store[KEY] as FilterEntry[];
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('keep-a');
    expect(entries[1].id).not.toBe('keep-a');
  });
});

describe('setFilterEntries', () => {
  it('writes the list through verbatim', async () => {
    const entries: FilterEntry[] = [{ id: 'x', phrase: 'p', createdAt: 9 }];
    await setFilterEntries(KEY, entries);
    expect(store[KEY]).toEqual(entries);
  });
});

describe('pendingImport (2-minute TTL)', () => {
  it('returns the code when it was set recently', async () => {
    await setPendingImport('bncr2_recent');
    expect(await getPendingImport()).toBe('bncr2_recent');
  });

  it('stamps a timestamp on set', async () => {
    await setPendingImport('bncr2_x');
    expect(typeof store.pendingImportAt).toBe('number');
  });

  it('expires (and clears) a handoff older than the TTL', async () => {
    store.pendingImport = 'bncr2_stale';
    store.pendingImportAt = Date.now() - (PENDING_IMPORT_TTL_MS + 1000);

    expect(await getPendingImport()).toBeUndefined();
    expect(store.pendingImport).toBeUndefined();   // cleared
    expect(store.pendingImportAt).toBeUndefined();
  });

  it('still returns a handoff right at the edge of the window', async () => {
    store.pendingImport = 'bncr2_edge';
    store.pendingImportAt = Date.now() - (PENDING_IMPORT_TTL_MS - 1000); // 1s inside

    expect(await getPendingImport()).toBe('bncr2_edge');
  });

  it('clearPendingImport removes both the code and the timestamp', async () => {
    await setPendingImport('bncr2_x');
    await clearPendingImport();
    expect(store.pendingImport).toBeUndefined();
    expect(store.pendingImportAt).toBeUndefined();
  });
});

describe('addImportedPhrases', () => {
  it('adds new phrases with sharedFrom provenance and returns the count', async () => {
    const added = await addImportedPhrases(KEY, ['politics', 'memes'], 'bncr2_src');

    expect(added).toBe(2);
    const entries = store[KEY] as FilterEntry[];
    expect(entries.map(e => e.phrase)).toEqual(['politics', 'memes']);
    expect(entries.every(e => e.sharedFrom === 'bncr2_src')).toBe(true);
  });

  it('skips phrases the user already has (no duplicates)', async () => {
    store[KEY] = [{ id: 'a', phrase: 'politics', createdAt: 1 }];

    const added = await addImportedPhrases(KEY, ['politics', 'crypto'], 'bncr2_src');

    expect(added).toBe(1); // only 'crypto' is new
    const entries = store[KEY] as FilterEntry[];
    expect(entries.map(e => e.phrase)).toEqual(['politics', 'crypto']);
    expect(entries[0].id).toBe('a'); // existing untouched, not re-added
  });

  it('returns 0 and writes nothing when every phrase is already present', async () => {
    store[KEY] = [{ id: 'a', phrase: 'politics', createdAt: 1 }];
    const before = store[KEY];

    const added = await addImportedPhrases(KEY, ['politics'], 'bncr2_src');

    expect(added).toBe(0);
    expect(store[KEY]).toBe(before); // same reference: no write
  });

  it('dedupes within the incoming phrase list too', async () => {
    const added = await addImportedPhrases(KEY, ['dup', 'dup', 'unique'], 'bncr2_src');

    expect(added).toBe(2);
    expect((store[KEY] as FilterEntry[]).map(e => e.phrase)).toEqual(['dup', 'unique']);
  });
});
