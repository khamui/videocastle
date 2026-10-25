import { desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { videos, type Video } from '../db/schema';
import type { MediaBytes } from '../media/media-store';

/**
 * Data access for Videos. Mirrors the style of {@link OperatorRepo}: Drizzle
 * builds the SQL, this class exposes a small intention-revealing surface, and
 * inserts are followed by a read-back (the sqlite-proxy driver is used without
 * RETURNING, matching the existing Operator pattern).
 */
export class VideoRepo {
  constructor(private readonly db: Database) {}

  /**
   * Inserts a freshly uploaded Video in the `processing` state and returns it.
   * The caller supplies the unguessable slug and the upload timestamp.
   */
  async create(input: {
    slug: string;
    title: string;
    description: string | null;
    createdAt: number;
  }): Promise<Video> {
    await this.db.insert(videos).values({
      slug: input.slug,
      title: input.title,
      description: input.description,
      state: 'processing',
      progress: 0,
      createdAt: input.createdAt,
    });
    const created = await this.findBySlug(input.slug);
    if (!created) {
      throw new Error('Video creation did not persist');
    }
    return created;
  }

  /** All Videos, newest first. */
  async list(): Promise<Video[]> {
    return this.db.select().from(videos).orderBy(desc(videos.id));
  }

  async findBySlug(slug: string): Promise<Video | undefined> {
    const rows = await this.db
      .select()
      .from(videos)
      .where(eq(videos.slug, slug))
      .limit(1);
    return rows[0];
  }

  async findById(id: number): Promise<Video | undefined> {
    const rows = await this.db
      .select()
      .from(videos)
      .where(eq(videos.id, id))
      .limit(1);
    return rows[0];
  }

  /** Records transcoding progress (0–100) for a Video still Processing. */
  async setProgress(id: number, progress: number): Promise<void> {
    await this.db.update(videos).set({ progress }).where(eq(videos.id, id));
  }

  /**
   * Marks a Video Ready: records its single Rendition and Poster, stamps the
   * probed duration, and completes progress.
   */
  async markReady(
    id: number,
    result: {
      playlistPath: string;
      posterPath: string;
      durationSeconds: number;
      /** What the transcode just wrote, measured by the worker. */
      renditionBytes: number;
      posterBytes: number;
    },
  ): Promise<void> {
    await this.db
      .update(videos)
      .set({
        state: 'ready',
        progress: 100,
        playlistPath: result.playlistPath,
        posterPath: result.posterPath,
        durationSeconds: result.durationSeconds,
        renditionBytes: result.renditionBytes,
        posterBytes: result.posterBytes,
      })
      .where(eq(videos.id, id));
  }

  /**
   * Re-queues a Failed Video for transcoding: back to `processing` with
   * progress reset and the prior failure diagnostics cleared, so a retry starts
   * from a clean slate (the Source is retained and reused). The caller is
   * responsible for having checked the Video was Failed and for enqueuing it.
   */
  async markProcessing(id: number): Promise<void> {
    await this.db
      .update(videos)
      .set({
        state: 'processing',
        progress: 0,
        failureReason: null,
        failureDetail: null,
        // The caller clears the old Rendition and Poster from disk before
        // re-queueing, so their recorded bytes go with them — otherwise the
        // instance would appear to hold media it has just deleted.
        renditionBytes: 0,
        posterBytes: 0,
      })
      .where(eq(videos.id, id));
  }

  /**
   * Marks a Video Failed after a transcode error, recording why so the Operator
   * sees an actionable reason and can retry (see {@link markProcessing}).
   */
  async markFailed(
    id: number,
    failure: { reason: string; detail?: string },
  ): Promise<void> {
    await this.db
      .update(videos)
      .set({
        state: 'failed',
        failureReason: failure.reason,
        failureDetail: failure.detail ?? null,
      })
      .where(eq(videos.id, id));
  }

  /**
   * Sets or clears a Video's password. Pass a scrypt hash to protect the Share
   * Link, or `null` to make it open again. The caller owns hashing (and the
   * decision to protect/unprotect); the repo just persists the value.
   */
  async setPasswordHash(id: number, passwordHash: string | null): Promise<void> {
    await this.db
      .update(videos)
      .set({ passwordHash })
      .where(eq(videos.id, id));
  }

  /**
   * Sets or clears a Video's Share Link expiry (epoch milliseconds, or `null`
   * to never expire). The same call extends an expiry or re-enables an expired
   * link by moving the instant forward; the repo just persists the value and
   * leaves the expired/not-expired judgement to the Clock-aware caller.
   */
  async setExpiresAt(id: number, expiresAt: number | null): Promise<void> {
    await this.db
      .update(videos)
      .set({ expiresAt })
      .where(eq(videos.id, id));
  }

  /**
   * Moves a Video into a Folder (by the Folder's id) or back to the Library
   * root (`null`). A Video belongs to at most one Folder — this single column
   * makes "never in two at once" structural. The caller validates the Folder
   * exists.
   */
  async setFolder(id: number, folderId: number | null): Promise<void> {
    await this.db.update(videos).set({ folderId }).where(eq(videos.id, id));
  }

  /** The Videos in a Folder (by id), or the Library root Videos (`null`), newest first. */
  async listByFolder(folderId: number | null): Promise<Video[]> {
    return this.db
      .select()
      .from(videos)
      .where(folderId === null ? isNull(videos.folderId) : eq(videos.folderId, folderId))
      .orderBy(desc(videos.id));
  }

  /** Removes a Video row — used to roll back a failed upload before it transcodes. */
  async delete(id: number): Promise<void> {
    await this.db.delete(videos).where(eq(videos.id, id));
  }

  /** Records what the Source weighed, once the upload stream has closed. */
  async setSourceBytes(id: number, sourceBytes: number): Promise<void> {
    await this.db.update(videos).set({ sourceBytes }).where(eq(videos.id, id));
  }

  /**
   * Overwrites all three recorded byte figures with measured ones. Only the
   * one-time backfill and `storage-reconcile --apply` do this; ordinary writes
   * record what they themselves wrote.
   */
  async setMediaBytes(id: number, bytes: MediaBytes): Promise<void> {
    await this.db
      .update(videos)
      .set({
        sourceBytes: bytes.sourceBytes,
        renditionBytes: bytes.renditionBytes,
        posterBytes: bytes.posterBytes,
      })
      .where(eq(videos.id, id));
  }

  /**
   * What this instance holds, as a `SUM()` over the recorded figures — never a
   * walk of the media directory, which would be O(Library) on every call.
   * Includes the Sources of Failed Videos: they are real bytes on a real disk.
   */
  async storageTotals(): Promise<MediaBytes> {
    const rows = await this.db
      .select({
        sourceBytes: sql<number>`coalesce(sum(${videos.sourceBytes}), 0)`,
        renditionBytes: sql<number>`coalesce(sum(${videos.renditionBytes}), 0)`,
        posterBytes: sql<number>`coalesce(sum(${videos.posterBytes}), 0)`,
      })
      .from(videos);
    const row = rows[0];
    return {
      sourceBytes: Number(row?.sourceBytes ?? 0),
      renditionBytes: Number(row?.renditionBytes ?? 0),
      posterBytes: Number(row?.posterBytes ?? 0),
    };
  }
}
