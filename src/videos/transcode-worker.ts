import { TranscodeError, type Transcoder } from '../ports/transcoder';
import type { MediaStore } from '../media/media-store';
import type { VideoRepo } from './video-repo';

/**
 * Drives Videos through transcoding off the request path. The upload route
 * enqueues a Video id and returns immediately; this worker picks it up, runs it
 * through the {@link Transcoder} port with capped concurrency (so transcoding
 * never starves the web server), and flips the Video to Ready (or Failed).
 *
 * `idle()` is the deterministic test hook: it resolves once no job is running
 * or queued, so a test can await the lifecycle completing without polling.
 */
export interface VideoWorker {
  enqueue(videoId: number): void;
  idle(): Promise<void>;
}

export interface TranscodeWorkerDeps {
  repo: VideoRepo;
  store: MediaStore;
  transcoder: Transcoder;
  /** Where transcode failures are reported; defaults to the console. */
  onError?: (videoId: number, err: unknown) => void;
  /**
   * Whether to keep the Source once the Rendition exists (ADR-0010). Defaults
   * to true — the Source is kept — so a caller that doesn't care gets today's
   * behaviour and never destroys an original by omission.
   */
  keepSource?: boolean;
  /** Reads the instant a discard is recorded at. Defaults to the system clock. */
  now?: () => number;
}

/**
 * @param concurrency How many transcodes run at once. The application passes
 * `config.transcodeConcurrency` (env `TRANSCODE_CONCURRENCY`); the default here
 * is the same value, for direct callers that don't care.
 */
export function createTranscodeWorker(
  deps: TranscodeWorkerDeps,
  concurrency = 2,
): VideoWorker {
  const queue: number[] = [];
  let active = 0;
  let idleWaiters: Array<() => void> = [];

  const onError =
    deps.onError ??
    ((videoId, err) => {
      // eslint-disable-next-line no-console
      console.error(`Transcode failed for video ${videoId}:`, err);
    });

  function settleIdle(): void {
    if (active === 0 && queue.length === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  async function run(videoId: number): Promise<void> {
    let outcome:
      | { kind: 'ready'; result: Awaited<ReturnType<Transcoder['transcode']>> }
      | { kind: 'failed'; failure: { reason: string; detail?: string } };
    try {
      await deps.store.ensureVideoDir(videoId);
      const result = await deps.transcoder.transcode({
        sourcePath: deps.store.sourcePath(videoId),
        outputDir: deps.store.videoDir(videoId),
        onProgress: (percent) =>
          deps.repo.setProgress(videoId, clampPercent(percent)),
      });
      outcome = { kind: 'ready', result };
    } catch (err) {
      onError(videoId, err);
      outcome = {
        kind: 'failed',
        failure:
          err instanceof TranscodeError
            ? { reason: err.reason, detail: err.detail }
            : { reason: 'encode_failed', detail: messageOf(err) },
      };
    }

    // Persist the outcome once the transcode has stopped writing. The whole
    // epilogue is best-effort and contained: a transcode that lands while the
    // DB is closing (shutdown) must never surface as an unhandled rejection
    // from this background job.
    try {
      // The Video may have been deleted while the transcode was in flight (a
      // Processing delete). The delete already purged the dir, but the
      // transcode kept writing into it afterwards; now that it has finished,
      // sweep the orphaned Rendition/Poster so deleted private footage is
      // really gone (spec: any ──delete──▶ gone) instead of recording state
      // against a vanished row.
      if (await deleted(videoId)) {
        await deps.store.removeVideo(videoId);
        return;
      }
      if (outcome.kind === 'ready') {
        // Measure what the transcode actually wrote, now that it has stopped
        // writing. Recorded here rather than computed on read, so usage never
        // costs a directory walk per request.
        const bytes = await deps.store.measureVideo(videoId);
        await deps.repo.markReady(videoId, {
          ...outcome.result,
          renditionBytes: bytes.renditionBytes,
          posterBytes: bytes.posterBytes,
        });

        // Only once the Video is Ready, never before: if the discard were to
        // run first and `markReady` then failed, the Video would be left with
        // no Source and no recorded Rendition — unplayable and unrecoverable.
        // This way the worst case is a Source that outlives the setting, which
        // `storage-reconcile` reports and `reclaim-sources` clears up.
        if (deps.keepSource === false) {
          await deps.store.removeSource(videoId);
          await deps.repo.discardSource(videoId, (deps.now ?? Date.now)());
        }
      } else {
        await deps.repo.markFailed(videoId, outcome.failure);
      }
    } catch (epilogueErr) {
      onError(videoId, epilogueErr);
    }
  }

  /** Whether the Video was deleted while its transcode was running. */
  async function deleted(videoId: number): Promise<boolean> {
    return (await deps.repo.findById(videoId)) === undefined;
  }

  function pump(): void {
    while (active < concurrency && queue.length > 0) {
      const videoId = queue.shift()!;
      active += 1;
      void run(videoId).finally(() => {
        active -= 1;
        pump();
        settleIdle();
      });
    }
  }

  return {
    enqueue(videoId) {
      queue.push(videoId);
      pump();
    },
    idle() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
