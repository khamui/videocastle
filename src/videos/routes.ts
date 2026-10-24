import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { hashPassword } from '../auth/password';
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
      transcoding: {
        available: status.available,
        version: status.version ?? null,
        // ADR-0007: tell the Operator the real reason it's unavailable.
        error: status.error ?? null,
      },
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
        return reply.code(503).send({
          error: 'transcoding_unavailable',
          detail: transcoding.current().error ?? undefined,
        });
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
        await store.removeVideo(created.id);
      }
      request.log.error(err, 'upload failed');
      // ADR-0007: the Operator owns the box — hand them the real cause.
      return reply.code(500).send({
        error: 'upload_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
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

  // Retry a Failed Video. The Source was retained through the failure, so this
  // simply re-queues transcoding (Failed → Processing) against the same file.
  // Only a Failed Video is retryable; retrying anything else is refused with
  // the Video's real state (ADR-0007: the real reason, not a genericised one).
  app.post<{ Params: { slug: string } }>(
    '/api/videos/:slug/retry',
    requireOperator,
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      if (!video) return videoNotFound(reply, request.params.slug);
      if (video.state !== 'failed') {
        return reply.code(409).send({
          error: 'not_retryable',
          detail: `Video "${video.slug}" is in state "${video.state}"; only a Failed Video can be retried.`,
        });
      }

      // Don't re-queue into a transcoder that can't run — it would only
      // re-fail. Retry is a deliberate, infrequent recovery action, so always
      // re-probe (unlike the high-frequency upload gate): this both catches an
      // ffmpeg that broke since boot and clears a stale "unavailable" the
      // moment the Operator fixes it.
      const status = await transcoding.refresh();
      if (!status.available) {
        return reply.code(503).send({
          error: 'transcoding_unavailable',
          detail: status.error ?? undefined,
        });
      }

      // Purge any partial Rendition/Poster the failed run left so the retry
      // transcodes into a clean output dir (the retained Source is kept).
      await store.clearRendition(video.id);

      // Read back the re-queued (Processing) Video before enqueuing, so the
      // response reflects the retry regardless of how fast the worker then runs
      // the job (a quick transcoder could otherwise flip the state first).
      await repo.markProcessing(video.id);
      const requeued = await repo.findById(video.id);
      worker.enqueue(video.id);
      return reply.code(200).send({ video: serializeVideo(requeued ?? video) });
    },
  );

  // Delete a Video: purge its Source and Rendition and kill its Share Link, so
  // private footage is really gone (spec: Operator story 19). The row is removed
  // first — that alone invalidates the link immediately (the slug stops
  // resolving) — then the media directory is purged from disk. Irreversible by
  // design; the Dashboard confirms before calling this (story 20).
  //
  // A deleted slug collapses into the same generic Viewer 404 as an unknown one
  // (ADR-0002, no existence leak) precisely because the row is gone: the Viewer
  // surface can no longer tell a deleted link from one that never existed.
  app.delete<{ Params: { slug: string } }>(
    '/api/videos/:slug',
    requireOperator,
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      // Operator surface (ADR-0007): the real reason, not a genericised one.
      if (!video) return videoNotFound(reply, request.params.slug);

      await repo.delete(video.id);
      await store.removeVideo(video.id);
      return reply.code(204).send();
    },
  );

  // Protect a Video with a password (spec: Operator story — password-protect a
  // link). The password is stored hashed (scrypt, same as the Operator
  // credential); the plaintext is never persisted or echoed back. Setting a
  // password on an already-protected Video simply replaces it.
  app.post<{ Params: { slug: string }; Body: { password?: unknown } }>(
    '/api/videos/:slug/password',
    requireOperator,
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      if (!video) return videoNotFound(reply, request.params.slug);

      const password =
        typeof request.body?.password === 'string' ? request.body.password.trim() : '';
      if (password.length === 0) {
        return reply.code(400).send({
          error: 'missing_password',
          detail: 'A non-empty password is required to protect a Video.',
        });
      }

      await repo.setPasswordHash(video.id, await hashPassword(password));
      const updated = await repo.findById(video.id);
      return reply.code(200).send({ video: serializeVideo(updated ?? video) });
    },
  );

  // Remove a Video's password, making its Share Link open again.
  app.delete<{ Params: { slug: string } }>(
    '/api/videos/:slug/password',
    requireOperator,
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      if (!video) return videoNotFound(reply, request.params.slug);

      await repo.setPasswordHash(video.id, null);
      const updated = await repo.findById(video.id);
      return reply.code(200).send({ video: serializeVideo(updated ?? video) });
    },
  );
}

/** The Operator-facing not-found (ADR-0007: the real reason, naming the slug). */
function videoNotFound(
  reply: import('fastify').FastifyReply,
  slug: string,
): import('fastify').FastifyReply {
  return reply.code(404).send({
    error: 'video_not_found',
    detail: `No Video with slug "${slug}".`,
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
  /** Whether a per-Video password gates the Share Link. The hash is never exposed. */
  protected: boolean;
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
    protected: video.passwordHash !== null,
    shareUrl: `/v/${video.slug}`,
    createdAt: video.createdAt,
  };
}
