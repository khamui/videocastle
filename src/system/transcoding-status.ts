import type { Transcoder, TranscoderAvailability } from '../ports/transcoder';

/**
 * Caches whether transcoding is usable (does ffmpeg actually run?) so the common
 * paths — gating uploads, answering `GET /api/status` — don't spawn a probe
 * every time. Checked once at boot; `refresh()` re-probes so an Operator who
 * installs ffmpeg recovers without restarting the server.
 */
export interface TranscodingStatus {
  current(): TranscoderAvailability;
  refresh(): Promise<TranscoderAvailability>;
}

export function createTranscodingStatus(
  transcoder: Transcoder,
): TranscodingStatus {
  let state: TranscoderAvailability = {
    available: false,
    version: undefined,
    error: 'not checked yet',
  };
  return {
    current: () => state,
    async refresh() {
      state = await transcoder.checkAvailable();
      return state;
    },
  };
}
