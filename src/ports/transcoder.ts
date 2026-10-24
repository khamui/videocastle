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

/**
 * Why a transcode failed, as a small stable set the UI and storage can rely on.
 * `transcode` rejects with a {@link TranscodeError} carrying one of these so the
 * Operator sees an actionable reason instead of a bare "failed".
 */
export type TranscodeFailureReason =
  | 'ffmpeg_not_found' // the ffmpeg/ffprobe binary isn't installed / on PATH
  | 'probe_failed' // ffprobe couldn't read the Source
  | 'no_video_stream' // the Source has no video to transcode
  | 'encode_failed' // ffmpeg errored while producing the Rendition
  | 'poster_failed'; // ffmpeg errored while grabbing the Poster

export class TranscodeError extends Error {
  readonly reason: TranscodeFailureReason;
  /** A short diagnostic (e.g. a trimmed ffmpeg stderr tail), if any. */
  readonly detail: string | undefined;

  constructor(
    reason: TranscodeFailureReason,
    message: string,
    detail?: string,
  ) {
    super(message);
    this.name = 'TranscodeError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** Whether transcoding is usable right now, with the backend version if known. */
export interface TranscoderAvailability {
  available: boolean;
  version: string | undefined;
  /** Why it's unavailable, when it isn't. */
  error: string | undefined;
}

export interface Transcoder {
  /** Transcodes a Source; rejects with a {@link TranscodeError} on failure. */
  transcode(request: TranscodeRequest): Promise<TranscodeResult>;
  /**
   * Reports whether transcoding can run (e.g. the real backend checks that
   * ffmpeg/ffprobe are present). Used at boot and to gate uploads.
   */
  checkAvailable(): Promise<TranscoderAvailability>;
}
