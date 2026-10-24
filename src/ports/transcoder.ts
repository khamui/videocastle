/**
 * Transcoder port.
 *
 * Transcoding a Source into its streamable HLS Rendition (plus a Poster) is
 * reached only through this interface, so the real `ffmpeg`-backed
 * implementation (src/transcode/ffmpeg-transcoder.ts) is swappable for a fake
 * that drives the Processing → Ready / Failed lifecycle synchronously in tests
 * (spec: Testing Decisions).
 */
export interface TranscodeRequest {
  /** Absolute path to the uploaded Source file on disk. */
  sourcePath: string;
  /** Directory into which the HLS Rendition and Poster should be written. */
  outputDir: string;
  /**
   * Optional progress sink, called with an integer percentage (0–100) as
   * transcoding advances, so the Library can show progress. The worker returns
   * the persistence promise, so an implementation may `await` it to apply
   * back-pressure; the real `ffmpeg` transcoder does not need to.
   */
  onProgress?: (percent: number) => void | Promise<void>;
}

export interface TranscodeResult {
  /** Path to the HLS playlist (relative to the Video's media directory). */
  playlistPath: string;
  /** Path to the generated Poster image. */
  posterPath: string;
  /** Source duration in seconds, as probed during transcoding. */
  durationSeconds: number;
}

export interface Transcoder {
  transcode(request: TranscodeRequest): Promise<TranscodeResult>;
}
