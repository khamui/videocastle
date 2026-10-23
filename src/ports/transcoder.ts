/**
 * Transcoder port.
 *
 * Transcoding a Source into its streamable HLS Rendition (plus a Poster) is
 * reached only through this interface, so the real `ffmpeg`-backed
 * implementation is swappable for a fake that drives the Processing → Ready /
 * Failed lifecycle synchronously in tests (spec: Testing Decisions).
 *
 * The concrete `ffmpeg` implementation and the fields of these types are
 * fleshed out in the upload/transcode ticket (#2); this port is defined here so
 * the walking skeleton can wire and inject it from the start.
 */
export interface TranscodeRequest {
  /** Absolute path to the uploaded Source file on disk. */
  sourcePath: string;
  /** Directory into which the HLS Rendition and Poster should be written. */
  outputDir: string;
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

/**
 * Placeholder real transcoder. The `ffmpeg`-backed implementation lands in the
 * upload/transcode ticket (#2); until then the walking skeleton wires this so
 * the port is always injected, and it fails loudly if transcoding is attempted.
 */
export const unimplementedTranscoder: Transcoder = {
  transcode() {
    return Promise.reject(
      new Error('Transcoder not implemented yet (see ticket #2).'),
    );
  },
};
