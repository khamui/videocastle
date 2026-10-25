import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { appConfig } from '../db/schema';
import type { VideoRepo } from '../videos/video-repo';
import type { MediaStore } from './media-store';
import { totalBytes } from './media-store';

/**
 * Fills in the recorded byte figures for Videos that predate storage
 * accounting. Those rows default to zero, so without this an upgrading
 * instance would report an empty disk while holding everything it ever
 * uploaded — the one number an Operator must be able to trust.
 *
 * It cannot be a SQL migration: the sizes are on the filesystem, not in the
 * database. So it runs once at boot behind a marker in `app_config`, which also
 * keeps it off the request path (reconciliation afterwards is the explicit
 * `storage-reconcile` command, never automatic).
 */
const MARKER_KEY = 'storage_backfill_done';

export interface BackfillResult {
  /** Videos whose figures were written. */
  measured: number;
  /** Videos found to hold nothing on disk — reported, not an error. */
  empty: number;
  totalBytes: number;
}

/** Whether the backfill has already run against this database. */
async function alreadyDone(db: Database): Promise<boolean> {
  const rows = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, MARKER_KEY))
    .limit(1);
  return rows.length > 0;
}

/**
 * Measures every Video's media and records it, once per instance. Returns
 * undefined when there was nothing to do, so the caller can stay quiet.
 *
 * A Video whose media cannot be read records zero rather than aborting the
 * boot: an instance with a half-restored media directory must still start, and
 * `storage-reconcile` is the tool for investigating what it found.
 */
export async function runStorageBackfill(deps: {
  db: Database;
  repo: VideoRepo;
  store: MediaStore;
}): Promise<BackfillResult | undefined> {
  if (await alreadyDone(deps.db)) return undefined;

  const videos = await deps.repo.list();
  const result: BackfillResult = { measured: 0, empty: 0, totalBytes: 0 };

  for (const video of videos) {
    const bytes = await deps.store.measureVideo(video.id);
    const total = totalBytes(bytes);
    await deps.repo.setMediaBytes(video.id, bytes);
    result.measured += 1;
    result.totalBytes += total;
    if (total === 0) result.empty += 1;
  }

  await deps.db
    .insert(appConfig)
    .values({ key: MARKER_KEY, value: new Date().toISOString() });

  // A fresh instance has no Videos, so there is nothing worth telling anyone
  // about — but the marker is still written, so this never runs again.
  return result.measured === 0 ? undefined : result;
}
