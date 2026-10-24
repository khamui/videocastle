import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { Clock } from '../ports/clock';
import type { SlugGenerator } from '../ports/slug';
import type { Video } from '../db/schema';
import type { MediaStore } from '../media/media-store';
import type { SessionManager } from '../auth/session';
import type { TranscodingStatus } from '../system/transcoding-status';
import type { VideoRepo } from './video-repo';
import type { VideoWorker } from './transcode-worker';

export interface VideoRouteOptions extends FastifyPluginOptions {
  session: SessionManager;
  repo: VideoRepo;
  worker: VideoWorker;
  store: MediaStore;
  slugGenerator: SlugGenerator;
  clock: Clock;
  transcoding: TranscodingStatus;
}

export async function registerVideoRoutes(
  app: FastifyInstance,
  options: VideoRouteOptions,
): Promise<void> {
  const { session, repo, worker, store, slugGenerator, clock, transcoding } =
    options;
  const requireOperator = { preHandler: session.requireOperator } as const;

  // Transcoding health, so the Dashboard can warn (and we can gate uploads)
  // when ffmpeg isn't runnable. Re-probes so recovery needs no restart.
  app.get('/api/status', requireOperator, async () => {
    const status = await transcoding.refresh();
    return {
      transcoding: { available: status.available, version: status.version ?? null },
    };
  });

  // Upload a Video. The file streams straight to disk (never buffered whole in
  // memory); the response returns the moment the Source is saved — in the
  // `processing` state with a usable Share Link — and transcoding runs on the
  // background worker. The client must send the `title`/`description` field
  // parts *before* the file part so the metadata is known when the file arrives.
  app.post('/api/videos', requireOperator, async (request, reply) => {
    // Refuse before reading the body when transcoding can't run — nothing good
    // can come of saving a Source we can't process. Re-probe first so an
    // Operator who just installed ffmpeg isn't blocked by a stale boot check.
    if (!transcoding.current().available) {
      await transcoding.refresh();
      if (!transcoding.current().available) {
        return reply.code(503).send({ error: 'transcoding_unavailable' });
      }
    }

    let title: string | undefined;
    let description: string | null = null;
    let created: Video | undefined;

    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'title') title = String(part.value).trim();
          else if (part.fieldname === 'description') {
            const value = String(part.value).trim();
            description = value.length > 0 ? value : null;
          }
          continue;
        }

        // The single file part. Everything we need to open the Source file must
        // be known by now; otherwise there is nothing valid to stream into.
        if (!title) {
          return reply.code(400).send({ error: 'missing_title' });
        }

        created = await repo.create({
          slug: slugGenerator.next(),
          title,
          description,
          createdAt: clock.now(),
        });
        await store.ensureVideoDir(created.id);
        await pipeline(part.file, createWriteStream(store.sourcePath(created.id)));
        break; // one file per upload; ignore any trailing parts
      }
    } catch (err) {
      // The upload failed mid-stream: roll back so a half-written Source and its
      // orphaned row don't linger. (Richer cap/disk-full handling is a later
      // ticket; this is the minimum that keeps a failed upload from leaving junk.)
      if (created) {
        await repo.delete(created.id);
        await rm(store.videoDir(created.id), { recursive: true, force: true });
      }
      request.log.error(err, 'upload failed');
      return reply.code(500).send({ error: 'upload_failed' });
    }

    if (!created) {
      return reply.code(400).send({ error: 'missing_file' });
    }

    worker.enqueue(created.id);
    return reply.code(201).send({ video: serializeVideo(created) });
  });

  // The Operator's Library: every Video with its state and transcoding progress.
  app.get('/api/videos', requireOperator, async () => {
    const all = await repo.list();
    return { videos: all.map(serializeVideo) };
  });
}

/**
 * The public shape of a Video. Deliberately omits the internal id and all
 * on-disk paths — the Library needs state, progress, and a Share Link, not the
 * storage layout.
 */
export interface VideoView {
  slug: string;
  title: string;
  description: string | null;
  state: string;
  progress: number;
  durationSeconds: number | null;
  /** Failure code when `state === 'failed'`, else null (see TranscodeFailureReason). */
  failureReason: string | null;
  /** Diagnostic detail for a failure, else null. Shown to the single Operator. */
  failureDetail: string | null;
  shareUrl: string;
  createdAt: number;
}

function serializeVideo(video: Video): VideoView {
  return {
    slug: video.slug,
    title: video.title,
    description: video.description,
    state: video.state,
    progress: video.progress,
    durationSeconds: video.durationSeconds,
    failureReason: video.failureReason,
    failureDetail: video.failureDetail,
    shareUrl: `/v/${video.slug}`,
    createdAt: video.createdAt,
  };
}
