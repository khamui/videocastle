/**
 * Byte sizes in the Host Configuration, parsed and printed.
 *
 * Storage limits are the one kind of setting an Operator writes in units: a
 * quota is "500GB", not "500000000000". Getting that wrong by a factor of 1000
 * is easy and silent, so the suffixes are explicit about which they mean —
 * decimal `GB` (10³) and binary `GiB` (2¹⁰) are both accepted and are not
 * treated as synonyms.
 */

/** Decimal and binary multipliers, longest suffix first so `GiB` beats `G`. */
const UNITS: Array<[suffix: string, multiplier: number]> = [
  ['KIB', 1024],
  ['MIB', 1024 ** 2],
  ['GIB', 1024 ** 3],
  ['TIB', 1024 ** 4],
  ['PIB', 1024 ** 5],
  ['KB', 1000],
  ['MB', 1000 ** 2],
  ['GB', 1000 ** 3],
  ['TB', 1000 ** 4],
  ['PB', 1000 ** 5],
  ['K', 1024],
  ['M', 1024 ** 2],
  ['G', 1024 ** 3],
  ['T', 1024 ** 4],
  ['P', 1024 ** 5],
  ['B', 1],
];

/**
 * Parses a size like `2147483648`, `2GiB`, `500GB` or `1.5TB` into whole bytes.
 * Returns undefined for anything unparseable or negative, so the caller can
 * fall back to its default rather than run on a number the Operator didn't
 * mean. A bare number is bytes, which keeps every value that worked before
 * suffixes existed working unchanged.
 *
 * A bare single-letter suffix (`512M`) is binary, matching `dd`, `free` and
 * most Unix tooling.
 */
export function parseBytes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().toUpperCase().replace(/\s+/g, '');
  if (text.length === 0) return undefined;

  for (const [suffix, multiplier] of UNITS) {
    if (!text.endsWith(suffix)) continue;
    const mantissa = text.slice(0, -suffix.length);
    // A suffix with no number in front of it ("GiB") is not zero bytes — it is
    // a value the Operator got wrong, and silently reading it as 0 would mean a
    // quota of nothing.
    if (mantissa.length === 0) return undefined;
    const n = Number(mantissa);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.floor(n * multiplier);
  }

  // No suffix: plain bytes.
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/** Like {@link parseBytes}, but falls back when the value is absent or junk. */
export function parseBytesOr(value: string | undefined, fallback: number): number {
  return parseBytes(value) ?? fallback;
}

const SCALE: Array<[unit: string, size: number]> = [
  ['TiB', 1024 ** 4],
  ['GiB', 1024 ** 3],
  ['MiB', 1024 ** 2],
  ['KiB', 1024],
];

/**
 * Human-readable binary size for reports and the Dashboard — `1.4 GiB`. Exact
 * byte counts stay alongside it wherever an Operator might need to act on the
 * number (ADR-0007), so this never replaces the raw figure.
 */
export function formatBytes(bytes: number): string {
  for (const [unit, size] of SCALE) {
    if (bytes >= size) return `${(bytes / size).toFixed(1)} ${unit}`;
  }
  return `${bytes} B`;
}
