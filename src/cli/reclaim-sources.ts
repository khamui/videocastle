import { loadConfig } from '../config';
import { openDatabase } from '../db/client';
import { MediaStore } from '../media/media-store';
import { formatBytes } from '../system/bytes';
import { VideoRepo } from '../videos/video-repo';
import type { Video } from '../db/schema';
import type { CliIo } from './reset-password';

/**
 * Discards the Sources of Videos that already have their Rendition, reclaiming
 * roughly half of what each Video costs on disk.
 *
 * This is the only thing that ever removes a Source the Operator already
 * holds. `KEEP_SOURCE_AFTER_TRANSCODE` governs Videos transcoded from now on
 * and never reaches back (ADR-0010): a setting that reads as "stop keeping
 * these from now on" must not mean "destroy the ones I kept". So reclaiming
 * them is a separate, explicit act — and it lives in the CLI rather than the
 * Dashboard because it is irreversible and bulk, and a web button that
 * permanently destroys every original an Operator holds is a mis-click waiting
 * to happen.
 *
 * It is **dry-run by default**, and it never touches a **Failed** Video's
 * Source: that Source is the only route back from a failed transcode, and
 * taking it would turn a recoverable failure into permanent loss.
 */

const USAGE =
  'Usage: videocastle reclaim-sources [--apply]\n' +
  '  Discards the Sources of Ready Videos, keeping their Renditions.\n' +
  '  Without --apply, reports what it would free and deletes nothing.\n' +
  '  A reclaimed Video keeps playing but can never be re-transcoded.\n' +
  '  Never touches a Failed Video — its Source is its only way back.';

/** Why a Video was passed over. */
type SkipReason = 'already-discarded' | 'not-ready' | 'no-source-on-disk';

const SKIP_LABEL: Record<SkipReason, string> = {
  'already-discarded': 'Source already discarded',
  'not-ready': 'not Ready — its Source is the only way back from a failed or unfinished transcode',
  'no-source-on-disk': 'no Source on disk (run storage-reconcile)',
};

export interface ReclaimCandidate {
  id: number;
  slug: string;
  title: string;
  sourceBytes: number;
}

export interface ReclaimSkip {
  id: number;
  slug: string;
  title: string;
  state: string;
  reason: SkipReason;
  sourceBytes: number;
}

export interface ReclaimReport {
  candidates: ReclaimCandidate[];
  skipped: ReclaimSkip[];
  /** Bytes freed (`--apply`) or that would be freed (dry run). */
  bytes: number;
  applied: boolean;
}

export async function reclaimSources(
  deps: { repo: VideoRepo; store: MediaStore; now: () => number },
  options: { apply: boolean } = { apply: false },
): Promise<ReclaimReport> {
  const candidates: ReclaimCandidate[] = [];
  const skipped: ReclaimSkip[] = [];
  let bytes = 0;

  for (const video of await deps.repo.list()) {
    const skip = skipReasonFor(video, await deps.store.hasSource(video.id));
    if (skip) {
      skipped.push({
        id: video.id,
        slug: video.slug,
        title: video.title,
        state: video.state,
        reason: skip,
        sourceBytes: video.sourceBytes,
      });
      continue;
    }

    candidates.push({
      id: video.id,
      slug: video.slug,
      title: video.title,
      sourceBytes: video.sourceBytes,
    });
    bytes += video.sourceBytes;

    if (options.apply) {
      await deps.store.removeSource(video.id);
      await deps.repo.discardSource(video.id, deps.now());
    }
  }

  return { candidates, skipped, bytes, applied: options.apply };
}

function skipReasonFor(video: Video, hasSource: boolean): SkipReason | undefined {
  if (video.sourceDiscardedAt !== null) return 'already-discarded';
  // Only a Ready Video has the Rendition that makes its Source expendable.
  // Processing is still reading it; Failed needs it to be retried.
  if (video.state !== 'ready') return 'not-ready';
  if (!hasSource) return 'no-source-on-disk';
  return undefined;
}

export function printReclaimReport(
  report: ReclaimReport,
  io: Pick<CliIo, 'out'>,
): void {
  if (report.candidates.length === 0) {
    io.out('No Sources to reclaim.');
  } else {
    const verb = report.applied ? 'Discarded' : 'Would discard';
    io.out(
      `${verb} ${report.candidates.length} ${
        report.candidates.length === 1 ? 'Source' : 'Sources'
      }, freeing ${report.bytes} bytes (${formatBytes(report.bytes)}):`,
    );
    for (const item of report.candidates) {
      io.out(
        `  video id=${item.id} slug=${item.slug} "${item.title}"  ` +
          `${item.sourceBytes} bytes (${formatBytes(item.sourceBytes)})`,
      );
    }
  }

  if (report.skipped.length > 0) {
    io.out(`Skipped ${report.skipped.length}:`);
    for (const item of report.skipped) {
      io.out(
        `  video id=${item.id} slug=${item.slug} "${item.title}" [${item.state}] — ` +
          SKIP_LABEL[item.reason],
      );
    }
  }

  if (!report.applied && report.candidates.length > 0) {
    io.out('');
    io.out(
      'Nothing was deleted. Re-run with --apply to discard these Sources. ' +
        'They cannot be recovered, and those Videos can never be re-transcoded ' +
        '— they will keep playing from the Renditions they already have.',
    );
  }
}

export async function runReclaimSourcesCommand(
  args: string[],
  io: CliIo,
): Promise<number> {
  const apply = args.includes('--apply');
  const unknown = args.filter((arg) => arg !== '--apply');
  if (unknown.length > 0) {
    io.err(`Unrecognised argument: ${unknown.join(' ')}`);
    io.err(USAGE);
    return 2;
  }

  const config = loadConfig(io.env);
  const database = openDatabase(config.dbPath);
  try {
    const report = await reclaimSources(
      {
        repo: new VideoRepo(database.db),
        store: new MediaStore(config.mediaDir),
        now: () => Date.now(),
      },
      { apply },
    );
    printReclaimReport(report, io);
    // A dry run that found work is not a failure — unlike `storage-reconcile`,
    // this command is not a health check, and exiting non-zero would make it
    // look like one in a cron log.
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  } finally {
    database.close();
  }
}
