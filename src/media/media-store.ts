import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

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
   * Purges everything a Video holds on disk — its Source, Rendition, and Poster
   * — by removing the Video's directory whole. Used when a Video is deleted (so
   * private footage is really gone) and to roll back a failed upload. `force`
   * makes it a no-op when the directory is already absent.
   */
  async removeVideo(id: number): Promise<void> {
    await rm(this.videoDir(id), { recursive: true, force: true });
  }
}
