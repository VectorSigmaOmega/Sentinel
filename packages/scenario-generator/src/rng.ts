export type Rng = {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  float(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
};

export function createRng(seed: string): Rng {
  let state = hashSeed(seed);

  function next(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  return {
    next,
    int(minInclusive, maxInclusive) {
      return Math.floor(next() * (maxInclusive - minInclusive + 1)) + minInclusive;
    },
    float(minInclusive, maxExclusive) {
      return next() * (maxExclusive - minInclusive) + minInclusive;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('Cannot pick from an empty array');
      return items[Math.floor(next() * items.length)]!;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
  };
}

function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (Math.imul(h ^ (h >>> 16), 2246822507) ^
    Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0;
}
