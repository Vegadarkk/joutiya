// À la Une draw (design D8): the engine returns up to FEATURED_POOL_SIZE boosted listings of the
// scope (category, subcategory, place); a few are drawn at random for the slots. The draw is seeded
// per request so one render is reproducible (tests, server and client agreeing on a seed) while
// successive requests rotate the boosted listings. Pure: no engine, no clock.

/** Boosted listings fetched per scope; the draw picks among them. */
export const FEATURED_POOL_SIZE = 20;
/** Slots above page 1 of /recherche and on /c pages. */
export const FEATURED_SEARCH_SLOTS = 2;
/** Home carousel. */
export const FEATURED_HOME_SLOTS = 8;

/** 32-bit FNV-1a of the seed string. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, good enough to shuffle a handful of cards (never for secrets). */
export function seededRandom(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` distinct items of `pool`, uniformly at random for `seed` (partial Fisher-Yates). Same
 * pool + seed = same draw; the pool is never mutated.
 */
export function drawFeatured<T>(pool: readonly T[], count: number, seed: string): T[] {
  const take = Math.max(0, Math.min(Math.floor(count), pool.length));
  if (take === 0) return [];
  const items = [...pool];
  const random = seededRandom(seed);
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(random() * (items.length - i));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items.slice(0, take);
}
