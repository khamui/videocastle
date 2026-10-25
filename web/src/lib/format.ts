const SCALE: Array<[unit: string, size: number]> = [
  ['TiB', 1024 ** 4],
  ['GiB', 1024 ** 3],
  ['MiB', 1024 ** 2],
  ['KiB', 1024],
];

/**
 * Human-readable binary size — `1.4 GiB`. Mirrors the server's `formatBytes`
 * (src/system/bytes.ts) the same way the API types in `api.ts` mirror the
 * server's views: duplicated deliberately, rather than reaching across into
 * server code from the browser bundle.
 *
 * Exact byte counts stay available beside it wherever an Operator might need to
 * act on the figure (ADR-0007); this never replaces the raw number.
 */
export function formatBytes(bytes: number): string {
  for (const [unit, size] of SCALE) {
    if (bytes >= size) return `${(bytes / size).toFixed(1)} ${unit}`;
  }
  return `${bytes} B`;
}

/** `12,378,433` — the exact figure, grouped so it can be read at a glance. */
export function exactBytes(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} bytes`;
}
