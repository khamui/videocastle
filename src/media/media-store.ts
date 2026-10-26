import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What a Video occupies on disk, split the way an Operator needs to see it: the
 * Source is the part they can choose to give up (ADR-0010), the Rendition is
 * the part that must stay for the Video to play.
 */
export interface MediaBytes {
  sourceBytes: number;
  renditionBytes: number;
  posterBytes: number;
}

export const NO_MEDIA_BYTES: MediaBytes = {
  sourceBytes: 0,
  renditionBytes: 0,
  posterBytes: 0,
};

export function totalBytes(bytes: MediaBytes): number {
  return bytes.sourceBytes + bytes.renditionBytes + bytes.posterBytes;
}

/** An entry in the media directory, and the Video it belongs to (if any). */
export interface MediaEntry {
  /** The directory name as it is on disk. */
  name: string;
  /** The Video id the name encodes, or null when the name isn't one. */
  videoId: number | null;
}

/**
 * Resolves the on-disk locations for a Video's media and owns the directory
 * layout, so no other module needs to know how media is arranged on disk.
 *
 * Layout, rooted at the configured media directory:
 *
 *   <mediaDir>/<id>/source                 the uploaded Source, as-is
 *   <mediaDir>/<id>/rendition/index.m3u8   the HLS playlist
 *   <mediaDir>/<id>/rendition/seg_*.ts     the HLS segments
 *   <mediaDir>/<id>/poster.jpg             the Poster still
 *
 * A Video's directory is keyed by its stable integer id rather than its slug,
 * so the public Share Link and the private disk layout stay decoupled.
 */
export class MediaStore {
  constructor(private readonly mediaDir: string) {}

  /** Absolute path to a Video's media directory (also the transcoder outputDir). */
  videoDir(id: number): string {
    return join(this.mediaDir, String(id));
  }

  /** Absolute path to a Video's Source file. */
  sourcePath(id: number): string {
    return join(this.videoDir(id), 'source');
  }

  /** Absolute path to a Video's HLS Rendition directory (playlist + segments). */
  renditionDir(id: number): string {
    return join(this.videoDir(id), 'rendition');
  }

  /** Absolute path to a Video's HLS playlist. */
  playlistPath(id: number): string {
    return join(this.renditionDir(id), 'index.m3u8');
  }

  /** Absolute path to a Video's Poster still. */
  posterPath(id: number): string {
    return join(this.videoDir(id), 'poster.jpg');
  }

  /** Absolute path to a named HLS segment (e.g. `seg_000.ts`) within the Rendition. */
  segmentPath(id: number, name: string): string {
    return join(this.renditionDir(id), name);
  }

  /** Creates a Video's media directory if it does not already exist. */
  async ensureVideoDir(id: number): Promise<void> {
    await mkdir(this.videoDir(id), { recursive: true });
  }

  /**
   * Removes a Video's Rendition and Poster while keeping its Source, so a retry
   * transcodes into a clean output directory — a partial Rendition left behind
   * by a failed run can't linger or bleed into the next attempt.
   */
  async clearRendition(id: number): Promise<void> {
    await rm(this.renditionDir(id), { recursive: true, force: true });
    await rm(this.posterPath(id), { force: true });
  }

  /**
   * Removes a Video's Source while leaving its Rendition and Poster in place,
   * so the Video keeps playing and only the ability to re-transcode is given
   * up (ADR-0010). Irreversible — the caller has established the Operator
   * asked for it.
   */
  async removeSource(id: number): Promise<void> {
    await rm(this.sourcePath(id), { force: true });
  }

  /** Whether a Video's Source is still on disk. */
  async hasSource(id: number): Promise<boolean> {
    return (await fileBytes(this.sourcePath(id))) > 0;
  }

  /**
   * Purges everything a Video holds on disk — its Source, Rendition, and Poster
   * — by removing the Video's directory whole. Used when a Video is deleted (so
   * private footage is really gone) and to roll back a failed upload. `force`
   * makes it a no-op when the directory is already absent.
   */
  async removeVideo(id: number): Promise<void> {
    await rm(this.videoDir(id), { recursive: true, force: true });
  }

  /**
   * Bytes the Source occupies right now, or 0 when there isn't one. Read once,
   * at the moment the upload stream closes, so the recorded figure never costs
   * a `stat` on a later request.
   */
  async sourceBytes(id: number): Promise<number> {
    return fileBytes(this.sourcePath(id));
  }

  /**
   * Measures everything a Video holds on disk. Used when the transcode lands,
   * by the one-time backfill, and by `storage-reconcile` — never on a request
   * path, where it would be a directory walk per call.
   */
  async measureVideo(id: number): Promise<MediaBytes> {
    const [sourceBytes, renditionBytes, posterBytes] = await Promise.all([
      fileBytes(this.sourcePath(id)),
      dirBytes(this.renditionDir(id)),
      fileBytes(this.posterPath(id)),
    ]);
    return { sourceBytes, renditionBytes, posterBytes };
  }

  /**
   * Everything in the media directory. An entry whose name isn't a Video id
   * still comes back (with `videoId: null`), because it is just as orphaned as
   * a numbered directory with no row behind it and the Operator should see it.
   */
  async listEntries(): Promise<MediaEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.mediaDir);
    } catch {
      // No media directory yet (a fresh instance) is an empty store, not an error.
      return [];
    }
    return names.map((name) => ({ name, videoId: videoIdOf(name) }));
  }

  /** Total bytes under a media-directory entry, by its on-disk name. */
  async entryBytes(name: string): Promise<number> {
    return pathBytes(join(this.mediaDir, name));
  }
}

/** The Video id a media-directory name encodes, or null when it isn't one. */
function videoIdOf(name: string): number | null {
  if (!/^\d+$/.test(name)) return null;
  const id = Number.parseInt(name, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A file's size, or 0 when it isn't there. Absent media is 0 bytes, not an error. */
async function fileBytes(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

/** Total size of a directory tree, or 0 when it isn't there. */
async function dirBytes(path: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return 0;
  }
  const sizes = await Promise.all(names.map((name) => pathBytes(join(path, name))));
  return sizes.reduce((sum, size) => sum + size, 0);
}

/** Total size of a path, following into directories. */
async function pathBytes(path: string): Promise<number> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return 0;
  }
  if (info.isDirectory()) return dirBytes(path);
  return info.isFile() ? info.size : 0;
}
