import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

// Promise wrapper around crypto.scrypt. We wrap by hand rather than use
// promisify because the options-carrying overload is needed and promisify's
// typings only expose the 3-argument form.
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// scrypt cost parameters. N=2^15 is a sensible interactive-login default; the
// parameters are stored alongside the hash so they can be raised later without
// invalidating existing credentials.
const KEYLEN = 64;
const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;

// scrypt throws unless `maxmem` covers ~128 * N * r bytes; the ×2 leaves
// headroom. Shared by hashing and verifying so the two can't drift apart.
function maxmemFor(n: number, r: number): number {
  return 128 * n * r * 2;
}

/**
 * Hashes a password with scrypt (Node's built-in; no native dependency, which
 * keeps the deploy dependency-free per ADR-0001). The returned string is
 * self-describing: `scrypt$N$r$p$saltHex$hashHex`.
 *
 * Note: the spec names argon2/bcrypt as examples; scrypt is used here because it
 * is a memory-hard password hash available in the Node standard library and
 * therefore needs no module to compile at deploy time.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: maxmemFor(COST, BLOCK_SIZE),
  });
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELISM}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verifies a password against a stored hash in constant time. Returns false for
 * any malformed stored value rather than throwing.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'hex');
  const expected = Buffer.from(parts[5]!, 'hex');
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  const derived = await scrypt(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: maxmemFor(n, r),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
