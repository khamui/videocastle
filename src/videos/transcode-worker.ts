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
}

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
    try {
      await deps.store.ensureVideoDir(videoId);
      const result = await deps.transcoder.transcode({
        sourcePath: deps.store.sourcePath(videoId),
        outputDir: deps.store.videoDir(videoId),
        onProgress: (percent) =>
          deps.repo.setProgress(videoId, clampPercent(percent)),
      });
      await deps.repo.markReady(videoId, result);
    } catch (err) {
      onError(videoId, err);
      const failure =
        err instanceof TranscodeError
          ? { reason: err.reason, detail: err.detail }
          : { reason: 'encode_failed', detail: messageOf(err) };
      // Best-effort: if even marking Failed throws (e.g. the DB is closing
      // during shutdown), contain it so a background job can never surface as
      // an unhandled rejection.
      try {
        await deps.repo.markFailed(videoId, failure);
      } catch (failErr) {
        onError(videoId, failErr);
      }
    }
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
