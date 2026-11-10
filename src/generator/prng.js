/**
 * Seeded pseudo-random utilities.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 *
 * Everything here is pure: the generator state lives inside the closure
 * returned by createRng, never in module-level variables.
 */

export const SEED_MIN = 0;
export const SEED_MAX = 4294967295;

/**
 * Check that a seed is an integer in [0, 4294967295].
 * @param {unknown} seed
 * @returns {number} the same seed
 * @throws {TypeError} if seed is not a number
 * @throws {RangeError} if seed is not an integer or is out of range
 */
export function validateSeed(seed) {
  if (typeof seed !== 'number') {
    throw new TypeError(`seed must be a number, got ${seed === null ? 'null' : typeof seed}`);
  }
  if (!Number.isInteger(seed) || seed < SEED_MIN || seed > SEED_MAX) {
    throw new RangeError(`seed must be an integer in [${SEED_MIN}, ${SEED_MAX}], got ${seed}`);
  }
  return seed;
}

/**
 * Create a mulberry32 random generator. State is local to the returned object.
 * @param {number} seed integer in [0, 4294967295]
 * @returns {{ next: () => number, gaussian: () => number }}
 */
export function createRng(seed) {
  validateSeed(seed);
  let state = seed >>> 0;

  /** Uniform number in [0, 1). */
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Standard normal number (mean 0, sd 1) using the Box-Muller transform. */
  function gaussian() {
    const u1 = 1 - next(); // in (0, 1], so log(u1) is finite
    const u2 = next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  return { next, gaussian };
}
/**
 * Derive an independent 32-bit seed for a named component from a base seed.
 * The same (seed, label) always gives the same result; different labels give
 * different, unrelated streams.
 * @param {number} seed base seed, integer in [0, 4294967295]
 * @param {string} label component name, for example "rr" or "tremor"
 * @returns {number} integer in [0, 4294967295]
 */
export function deriveSeed(seed, label) {
  validateSeed(seed);
  if (typeof label !== 'string' || label.length === 0) {
    throw new TypeError('label must be a non-empty string');
  }
  // FNV-1a over the label, mixed with the seed, then a murmur3-style finalizer.
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}