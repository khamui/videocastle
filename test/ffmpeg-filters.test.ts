import { describe, expect, it } from 'vitest';
import { buildVideoFilter, isHdrTransfer } from '../src/transcode/ffmpeg-transcoder';

/**
 * Pure checks on the filtergraph construction — no ffmpeg needed. These guard
 * the behaviour that makes real phone footage (10-bit HDR HEVC, e.g. an
 * iPhone's `.mov`) produce browser-playable SDR output.
 */
describe('HDR detection', () => {
  it('treats PQ and HLG transfers as HDR', () => {
    expect(isHdrTransfer('smpte2084')).toBe(true); // HDR10 / Dolby Vision
    expect(isHdrTransfer('arib-std-b67')).toBe(true); // HLG (iPhone Dolby Vision 8.4)
  });

  it('treats SDR / unknown transfers as not HDR', () => {
    expect(isHdrTransfer('bt709')).toBe(false);
    expect(isHdrTransfer('unknown')).toBe(false);
    expect(isHdrTransfer(undefined)).toBe(false);
  });
});

describe('video filtergraph', () => {
  it('always caps to 1080p and outputs 8-bit yuv420p', () => {
    for (const isHdr of [false, true]) {
      const filter = buildVideoFilter(isHdr);
      expect(filter).toContain("'min(iw,1920)'");
      expect(filter).toContain("'min(ih,1080)'");
      expect(filter.endsWith('format=yuv420p')).toBe(true);
    }
  });

  it('tone-maps HDR sources but leaves SDR sources alone', () => {
    expect(buildVideoFilter(false)).not.toContain('tonemap');
    const hdr = buildVideoFilter(true);
    expect(hdr).toContain('zscale=t=linear');
    expect(hdr).toContain('tonemap=tonemap=hable');
    expect(hdr).toContain('zscale=t=bt709');
  });
});
