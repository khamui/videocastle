import { mkdir } from 'node:fs/promises';
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

  /** Creates a Video's media directory if it does not already exist. */
  async ensureVideoDir(id: number): Promise<void> {
    await mkdir(this.videoDir(id), { recursive: true });
  }
}
