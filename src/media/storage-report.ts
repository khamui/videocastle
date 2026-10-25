import { stat } from 'node:fs/promises';
import { totalBytes, type MediaBytes } from './media-store';
import type { StorageGuard } from './storage-guard';

/**
 * What the Dashboard shows about storage. The Operator owns the server, so the
 * figures are stated plainly, including the uncomfortable ones: a Quota lowered
 * below what is held reports over 100% rather than a bar clamped to full
 * (ADR-0011), and a free-disk probe that failed says so rather than showing a
 * confident zero.
 */

/** How close to a ceiling this instance is. */
export type StoragePressure = 'ok' | 'warning' | 'full';

export interface StorageReport extends MediaBytes {
  /** Media bytes held: the sum of the three above. */
  totalBytes: number;
  /** The Quota, or null when unlimited. */
  quotaBytes: number | null;
  /** Free space that must remain on the media filesystem. */
  minFreeDiskBytes: number;
  /** Free bytes on the media filesystem, or null when the probe failed. */
  freeDiskBytes: number | null;
  /** Bytes a new Source may still occupy, or null when nothing caps it. */
  writableBytes: number | null;
  /** Where the warning band starts, as a percentage of the Quota. */
  warnPercent: number;
  /**
   * Media held as a percentage of the Quota, or null when unlimited. Can exceed
   * 100: an Operator may lower the Quota below what is already stored, and
   * clamping it would imply the media just fits.
   */
  usedPercent: number | null;
  pressure: StoragePressure;
  /**
   * The SQLite file's size. Shown for completeness and **excluded from the
   * Quota**, which is about media — but an Operator totting up what the
   * instance costs should not have to wonder where it went.
   */
  databaseBytes: number | null;
}

/**
 * `warning` once the Quota is `warnPercent` full; `full` once a ceiling leaves
 * nothing writable — including the free-disk floor, which can be reached with
 * no Quota set at all.
 */
function pressureOf(input: {
  writableBytes: number | null;
  usedPercent: number | null;
  warnPercent: number;
}): StoragePressure {
  if (input.writableBytes !== null && input.writableBytes <= 0) return 'full';
  if (input.usedPercent !== null && input.usedPercent >= input.warnPercent) {
    return 'warning';
  }
  return 'ok';
}

export async function buildStorageReport(deps: {
  totals: MediaBytes;
  guard: StorageGuard;
  warnPercent: number;
  dbPath: string;
}): Promise<StorageReport> {
  const allowance = await deps.guard.allowance();
  const used = totalBytes(deps.totals);
  const quotaBytes = deps.guard.limits.quotaBytes ?? null;

  const usedPercent =
    quotaBytes === null || quotaBytes === 0
      ? null
      : Math.round((used / quotaBytes) * 100);
  const writableBytes = Number.isFinite(allowance.bytes) ? allowance.bytes : null;

  return {
    ...deps.totals,
    totalBytes: used,
    quotaBytes,
    minFreeDiskBytes: deps.guard.limits.minFreeDiskBytes,
    freeDiskBytes: allowance.freeDiskBytes ?? null,
    writableBytes,
    warnPercent: deps.warnPercent,
    usedPercent,
    pressure: pressureOf({ writableBytes, usedPercent, warnPercent: deps.warnPercent }),
    databaseBytes: await fileBytesOrNull(deps.dbPath),
  };
}

/** The database is `:memory:` in tests, and may be unreadable; either is null. */
async function fileBytesOrNull(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}
