import { statfs } from 'node:fs/promises';
import { totalBytes, type MediaBytes } from './media-store';

/**
 * The two ceilings a server's owner can put on this instance, and the single
 * question the write paths ask of them: how many more bytes may we write?
 *
 * Reaching a ceiling **refuses the write**. Nothing is ever deleted, evicted or
 * pruned to make room, and playback of what is already stored is never gated
 * (ADR-0011) — a full disk costs the Operator the ability to add Videos, never
 * a Viewer the ability to watch one they hold a link to.
 */

/** Stable machine codes for a refusal (ADR-0007). */
export type StorageRefusalReason = 'quota_exceeded' | 'disk_floor_reached';

export interface StorageRefusal {
  reason: StorageRefusalReason;
  /** The real figures, for the Operator to act on (ADR-0007). */
  detail: string;
}

export interface StorageLimits {
  /** Ceiling on total media bytes (`STORAGE_QUOTA_BYTES`), or undefined for unlimited. */
  quotaBytes: number | undefined;
  /** Free space that must remain on the media filesystem (`MIN_FREE_DISK_BYTES`). */
  minFreeDiskBytes: number;
}

/** How much more may be written, and which ceiling decides it. */
export interface StorageAllowance {
  /** Bytes a new Source may occupy. `Infinity` when nothing caps it. */
  bytes: number;
  /** The ceiling that sets `bytes`, or undefined when neither applies. */
  reason: StorageRefusalReason | undefined;
  /** Media bytes recorded for this instance. */
  usedBytes: number;
  /** Free bytes on the media filesystem, or undefined when it couldn't be read. */
  freeDiskBytes: number | undefined;
}

export interface StorageGuard {
  /** Probes both ceilings. One `SUM()` plus one `statfs` per call. */
  allowance(): Promise<StorageAllowance>;
  limits: StorageLimits;
}

/** What a storage refusal looks like once a write has been judged too big. */
export function refusalFor(
  allowance: StorageAllowance,
  wanted: number,
  limits: StorageLimits,
): StorageRefusal {
  if (allowance.reason === 'disk_floor_reached') {
    return {
      reason: 'disk_floor_reached',
      detail:
        `The media filesystem has ${allowance.freeDiskBytes ?? 'an unknown number of'} bytes free and ` +
        `MIN_FREE_DISK_BYTES reserves ${limits.minFreeDiskBytes}, leaving ${allowance.bytes} ` +
        `bytes writable; this upload needs ${wanted}. Free disk space on the host, or lower ` +
        `MIN_FREE_DISK_BYTES. Nothing was deleted to make room (ADR-0011).`,
    };
  }
  return {
    reason: 'quota_exceeded',
    detail:
      `This instance holds ${allowance.usedBytes} of its ${limits.quotaBytes}-byte ` +
      `STORAGE_QUOTA_BYTES, leaving ${allowance.bytes} bytes writable; this upload needs ` +
      `${wanted}. Delete Videos you no longer need, or raise STORAGE_QUOTA_BYTES. Nothing ` +
      `was deleted to make room (ADR-0011).`,
  };
}

/**
 * Free bytes available to an unprivileged writer on the filesystem holding
 * `path`, or undefined when the filesystem cannot be interrogated.
 *
 * `bavail` rather than `bfree`: the blocks reserved for root are not space this
 * process can use, and counting them would let the floor be crossed silently.
 */
export async function freeDiskBytes(path: string): Promise<number | undefined> {
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

export function createStorageGuard(deps: {
  repo: { storageTotals(): Promise<MediaBytes> };
  /** The directory whose filesystem the free-disk floor is measured against. */
  mediaDir: string;
  limits: StorageLimits;
}): StorageGuard {
  const { limits } = deps;

  return {
    limits,
    async allowance(): Promise<StorageAllowance> {
      const used = totalBytes(await deps.repo.storageTotals());
      const free = await freeDiskBytes(deps.mediaDir);

      const quotaRoom =
        limits.quotaBytes === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, limits.quotaBytes - used);

      // An unreadable filesystem is not a ceiling that has been reached, so it
      // does not refuse writes — the Quota still applies, and the failed probe
      // surfaces as an unknown free-disk figure rather than as a refusal an
      // Operator could not act on.
      const diskRoom =
        free === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, free - limits.minFreeDiskBytes);

      const binding: StorageAllowance = {
        bytes: Math.min(quotaRoom, diskRoom),
        reason: undefined,
        usedBytes: used,
        freeDiskBytes: free,
      };
      if (!Number.isFinite(binding.bytes)) return binding;
      // Report the tighter ceiling. A tie goes to the Quota: it is the one the
      // Operator configured deliberately, so it is the more useful thing to be
      // told about.
      binding.reason = quotaRoom <= diskRoom ? 'quota_exceeded' : 'disk_floor_reached';
      return binding;
    },
  };
}
