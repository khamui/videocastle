import { randomBytes } from 'node:crypto';

/**
 * Slug generator port.
 *
 * Produces the short, unguessable, URL-safe strings used as Share Link slugs
 * for Videos and Folders (ADR-0002). Injected so links are deterministic in
 * tests and collisions can be forced.
 */
export interface SlugGenerator {
  next(): string;
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Real generator: ~`length` characters of base62 drawn from a CSPRNG.
 * Default length 10 gives ~59 bits of entropy (ADR-0002: ~10-char base62).
 */
export function createSlugGenerator(length = 10): SlugGenerator {
  return {
    next() {
      // Rejection-free: map each random byte into base62. Bytes are uniform
      // over 0..255; `% 62` introduces a negligible bias acceptable for slugs.
      const bytes = randomBytes(length);
      let out = '';
      for (let i = 0; i < length; i++) {
        out += BASE62[bytes[i]! % 62];
      }
      return out;
    },
  };
}
