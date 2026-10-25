import { loadConfig } from '../config';
import { openDatabase } from '../db/client';
import { MediaStore, totalBytes, type MediaBytes } from '../media/media-store';
import { formatBytes } from '../system/bytes';
import { VideoRepo } from '../videos/video-repo';
import type { CliIo } from './reset-password';

/**
 * Compares the byte figures recorded against each Video with what is actually
 * on disk, and reports what it finds.
 *
 * Recording sizes at write time is what keeps usage off the request path, but
 * it means the numbers can drift — a crash between writing media and recording
 * it, a restore from a backup taken at a different moment, a file removed by
 * hand. This is the tool that tells an Operator whether the figure in their
 * Dashboard is still true.
 *
 * Two deliberate properties:
 *
 *  - **Dry-run by default.** Reporting is safe; writing is opt-in (`--apply`).
 *  - **Non-zero exit on any finding**, so `storage-reconcile` works as a cron
 *    health check without parsing its output.
 *
 * It never deletes anything, in either mode (ADR-0011). Orphaned media is
 * reported with the command to remove it, because a tool that deletes
 * directories on the strength of its own reading of the database turns a
 * restore from backup into permanent data loss.
 */

const USAGE =
  'Usage: videocastle storage-reconcile [--apply]\n' +
  '  Compares recorded media sizes against what is on disk.\n' +
  '  Without --apply, reports only and writes nothing.\n' +
  '  Exits 0 when everything agrees, 1 when anything was found, 2 on bad usage.\n' +
  '  Never deletes media, with or without --apply (ADR-0011).';

/** A Video whose recorded figures disagree with the disk. */
interface Drift {
  id: number;
  slug: string;
  title: string;
  recorded: MediaBytes;
  measured: MediaBytes;
  /** True when the row claims media that is entirely gone from disk. */
  mediaMissing: boolean;
}

/** Media on disk with no Video behind it. */
interface Orphan {
  name: string;
  bytes: number;
}

export interface ReconcileReport {
  videosChecked: number;
  drift: Drift[];
  orphans: Orphan[];
  /** Whether the drifted figures were written back. */
  applied: boolean;
}

function differs(a: MediaBytes, b: MediaBytes): boolean {
  return (
    a.sourceBytes !== b.sourceBytes ||
    a.renditionBytes !== b.renditionBytes ||
    a.posterBytes !== b.posterBytes
  );
}

/**
 * Walks every Video and every media directory. Writes corrected figures only
 * when `apply` is set; collects orphans either way without touching them.
 */
export async function reconcileStorage(
  deps: { repo: VideoRepo; store: MediaStore },
  options: { apply: boolean } = { apply: false },
): Promise<ReconcileReport> {
  const videos = await deps.repo.list();
  const drift: Drift[] = [];

  for (const video of videos) {
    const recorded: MediaBytes = {
      sourceBytes: video.sourceBytes,
      renditionBytes: video.renditionBytes,
      posterBytes: video.posterBytes,
    };
    const measured = await deps.store.measureVideo(video.id);
    if (!differs(recorded, measured)) continue;

    drift.push({
      id: video.id,
      slug: video.slug,
      title: video.title,
      recorded,
      measured,
      mediaMissing: totalBytes(measured) === 0 && totalBytes(recorded) > 0,
    });
    if (options.apply) await deps.repo.setMediaBytes(video.id, measured);
  }

  // Anything in the media directory that no Video claims. Includes entries
  // whose name isn't a Video id at all — equally orphaned, equally the
  // Operator's to look at.
  const known = new Set(videos.map((video) => video.id));
  const orphans: Orphan[] = [];
  for (const entry of await deps.store.listEntries()) {
    if (entry.videoId !== null && known.has(entry.videoId)) continue;
    orphans.push({ name: entry.name, bytes: await deps.store.entryBytes(entry.name) });
  }

  return {
    videosChecked: videos.length,
    drift,
    orphans,
    applied: options.apply,
  };
}

/** Both figures, so the Operator can see the shape of the disagreement. */
function describe(bytes: MediaBytes): string {
  return (
    `source=${bytes.sourceBytes} rendition=${bytes.renditionBytes} ` +
    `poster=${bytes.posterBytes} total=${totalBytes(bytes)}`
  );
}

/**
 * Prints the report. Technical and copy-pasteable (ADR-0007): ids, slugs, exact
 * byte counts on both sides, and the delta — not a summary an Operator would
 * have to come back and ask about.
 */
export function printReconcileReport(
  report: ReconcileReport,
  io: Pick<CliIo, 'out'>,
  mediaDir: string,
): void {
  io.out(`media dir: ${mediaDir}`);
  io.out(`videos checked: ${report.videosChecked}`);

  if (report.drift.length === 0) {
    io.out('recorded sizes: all agree with disk');
  } else {
    io.out(
      `recorded sizes: ${report.drift.length} ${
        report.drift.length === 1 ? 'Video' : 'Videos'
      } disagree with disk${report.applied ? ' (corrected)' : ''}`,
    );
    for (const item of report.drift) {
      const delta = totalBytes(item.measured) - totalBytes(item.recorded);
      io.out(`  video id=${item.id} slug=${item.slug} "${item.title}"`);
      io.out(`    recorded: ${describe(item.recorded)}`);
      io.out(`    on disk:  ${describe(item.measured)}`);
      io.out(
        `    delta:    ${delta >= 0 ? '+' : ''}${delta} bytes (${formatBytes(Math.abs(delta))})`,
      );
      if (item.mediaMissing) {
        io.out(
          '    NOTE: this Video holds nothing on disk — its media is gone, ' +
            'not merely mis-counted, and it cannot play.',
        );
      }
    }
  }

  if (report.orphans.length === 0) {
    io.out('orphaned media: none');
  } else {
    const total = report.orphans.reduce((sum, orphan) => sum + orphan.bytes, 0);
    io.out(
      `orphaned media: ${report.orphans.length} ${
        report.orphans.length === 1 ? 'entry' : 'entries'
      } with no Video, ${total} bytes (${formatBytes(total)})`,
    );
    for (const orphan of report.orphans) {
      io.out(`  ${mediaDir}/${orphan.name}  ${orphan.bytes} bytes`);
    }
    // ADR-0011: this command never deletes Operator media, so say what would.
    io.out(
      '  Not removed: this command never deletes media. Check these are not ' +
        'needed, then remove them yourself, e.g.:',
    );
    for (const orphan of report.orphans) {
      io.out(`    rm -rf '${mediaDir}/${orphan.name}'`);
    }
  }

  if (report.drift.length > 0 && !report.applied) {
    io.out('Run again with --apply to write the measured sizes.');
  }
}

/**
 * The exit code. Non-zero whenever anything was found that an Operator should
 * look at, so this can be a cron job whose failure is the alert:
 *
 *  - dry run: drift or orphans
 *  - `--apply`: orphans, and Videos whose media turned out to be missing (the
 *    figures are now correct, but the Video still can't play)
 */
export function reconcileExitCode(report: ReconcileReport): number {
  const unresolved = report.applied
    ? report.orphans.length + report.drift.filter((d) => d.mediaMissing).length
    : report.orphans.length + report.drift.length;
  return unresolved > 0 ? 1 : 0;
}

/**
 * CLI entrypoint. Opens the configured datastore read-write (WAL and
 * `busy_timeout` make this safe against the running server) and reports.
 */
export async function runStorageReconcileCommand(
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
    const report = await reconcileStorage(
      { repo: new VideoRepo(database.db), store: new MediaStore(config.mediaDir) },
      { apply },
    );
    printReconcileReport(report, io, config.mediaDir);
    return reconcileExitCode(report);
  } catch (err) {
    // ADR-0007: hand the Operator the real cause.
    io.err(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  } finally {
    database.close();
  }
}
