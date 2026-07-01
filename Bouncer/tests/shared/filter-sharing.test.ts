import { describe, it, expect } from 'vitest';
import { buildFiltersShareUrl } from '../../src/shared/filter-sharing.js';
import {
  decodeFilterPackCode,
  FILTER_PACK_SHARE_URL_REGEX,
  FILTER_PACK_SHARE_URL_BASE,
} from '../../src/shared/share-encoding.js';
import type { FilterEntry } from '../../src/types.js';

const entry = (phrase: string, over: Partial<FilterEntry> = {}): FilterEntry => ({
  id: `id-${phrase}`,
  phrase,
  createdAt: 0,
  ...over,
});

/** Pull the bncr2_ code back out of a share URL and decode it to phrases. */
async function phrasesFromUrl(url: string): Promise<string[]> {
  const m = url.match(FILTER_PACK_SHARE_URL_REGEX);
  expect(m).not.toBeNull();
  const decoded = await decodeFilterPackCode(m![1]);
  expect(decoded).not.toBeNull();
  return decoded!.phrases;
}

describe('buildFiltersShareUrl', () => {
  it('shares a single filter (passed as one entry)', async () => {
    const url = await buildFiltersShareUrl(entry('crypto'));
    expect(await phrasesFromUrl(url)).toEqual(['crypto']);
  });

  it('shares all filters (passed as a list), preserving order', async () => {
    const url = await buildFiltersShareUrl([
      entry('politics'),
      entry('memes'),
      entry('technology'),
    ]);
    expect(await phrasesFromUrl(url)).toEqual(['politics', 'memes', 'technology']);
  });

  it('produces a well-formed Bouncer share URL', async () => {
    const url = await buildFiltersShareUrl(entry('spam'));
    expect(url).toContain(FILTER_PACK_SHARE_URL_BASE);
    expect(url).toMatch(/#bncr2_/);
  });

  it('collapses duplicate phrases when sharing all', async () => {
    const url = await buildFiltersShareUrl([
      entry('dup', { id: 'id-1' }),
      entry('dup', { id: 'id-2' }),
      entry('unique'),
    ]);
    expect(await phrasesFromUrl(url)).toEqual(['dup', 'unique']);
  });

  it('shares only the phrase — id/createdAt/sharedFrom are local-only', async () => {
    const url = await buildFiltersShareUrl(
      entry('ads', { id: 'secret', createdAt: 999, sharedFrom: 'bncr2_origin' }),
    );
    expect(await phrasesFromUrl(url)).toEqual(['ads']);
  });
});

describe('FILTER_PACK_SHARE_URL_REGEX backward compatibility', () => {
  it('matches the current bouncer.imbue.com/import link', () => {
    const m = 'https://bouncer.imbue.com/import#bncr2_ABC123'.match(FILTER_PACK_SHARE_URL_REGEX);
    expect(m?.[1]).toBe('bncr2_ABC123');
  });

  it('still matches legacy imbue.com/product/bouncer links already shared on X', () => {
    const m = 'https://imbue.com/product/bouncer#bncr2_OLD999'.match(FILTER_PACK_SHARE_URL_REGEX);
    expect(m?.[1]).toBe('bncr2_OLD999');
  });

  it('matches without an explicit scheme (Twitter sometimes drops it)', () => {
    const m = 'bouncer.imbue.com/import#bncr2_NOSCHEME'.match(FILTER_PACK_SHARE_URL_REGEX);
    expect(m?.[1]).toBe('bncr2_NOSCHEME');
  });
});
