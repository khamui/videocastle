import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfmpegTranscoder } from '../src/transcode/ffmpeg-transcoder';

/**
 * The one slow, external, nondeterministic piece: validated lightly against a
 * real ffmpeg and skipped entirely where ffmpeg/ffprobe aren't installed, so
 * the behavioural suite stays fast and hermetic.
 *
 * The matrix stands in for "support as many modern phone formats as possible":
 * each case is a synthetic clip resembling a real capture (SDR, 10-bit HDR in
 * HLG and PQ, portrait, no-audio, odd dimensions, multi-audio), and the test
 * asserts the output is always browser-playable 8-bit H.264 + (stereo) AAC HLS.
 */
const hasFfmpeg = onPath('ffmpeg') && onPath('ffprobe');
const describeFfmpeg = hasFfmpeg ? describe : describe.skip;

function onPath(binary: string): boolean {
  return spawnSync(binary, ['-version'], { stdio: 'ignore' }).status === 0;
}

/** Runs ffmpeg to generate a source clip; throws (failing the test) on error. */
function ffmpeg(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-nostdin', '-y', ...args], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`ffmpeg generate failed: ${res.stderr?.slice(-400)}`);
  }
}

interface StreamInfo {
  codec_type: string;
  codec_name: string;
  pix_fmt?: string;
  channels?: number;
}

function probeStreams(path: string): StreamInfo[] {
  const res = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,pix_fmt,channels',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(res.stdout) as { streams?: StreamInfo[] };
  return parsed.streams ?? [];
}

const VIDEO = (size: string) =>
  `testsrc=duration=2:size=${size}:rate=10`;
const AUDIO = 'sine=frequency=440:duration=2';

describeFfmpeg('ffmpeg transcoder — format matrix (requires ffmpeg on PATH)', () => {
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'vc-ffmpeg-'));
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  interface Case {
    name: string;
    gen: (src: string) => string[];
    expectAudio: boolean;
    /** Source container extension (default mp4). */
    ext?: string;
  }

  // 10-bit HDR clips use libx264's High 10 profile (no libx265 dependency); the
  // color-transfer tag is what drives the tone-map, independent of codec.
  const hdr = (size: string, trc: string): ((src: string) => string[]) =>
    (src) => [
      '-f', 'lavfi', '-i', VIDEO(size),
      '-f', 'lavfi', '-i', AUDIO,
      '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le',
      '-color_primaries', 'bt2020', '-color_trc', trc, '-colorspace', 'bt2020nc',
      '-c:a', 'aac', src,
    ];

  const sdr = (size: string, withAudio: boolean): ((src: string) => string[]) =>
    (src) => [
      '-f', 'lavfi', '-i', VIDEO(size),
      ...(withAudio ? ['-f', 'lavfi', '-i', AUDIO, '-shortest'] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      ...(withAudio ? ['-c:a', 'aac'] : []),
      src,
    ];

  const cases: Case[] = [
    { name: 'H.264 / mp4 SDR', gen: sdr('320x240', true), expectAudio: true },
    { name: 'HEVC-like 10-bit HLG HDR', gen: hdr('320x240', 'arib-std-b67'), expectAudio: true },
    { name: '10-bit PQ HDR', gen: hdr('320x240', 'smpte2084'), expectAudio: true },
    { name: 'portrait', gen: sdr('240x426', true), expectAudio: true },
    { name: 'no audio', gen: sdr('320x240', false), expectAudio: false },
    {
      // libx264 can't *encode* odd dimensions (the very thing our pipeline
      // guards against), so generate with ffv1/mkv, which permits them.
      name: 'odd dimensions',
      ext: 'mkv',
      gen: (src) => [
        '-f', 'lavfi', '-i', VIDEO('641x361'),
        '-f', 'lavfi', '-i', AUDIO, '-shortest',
        '-c:v', 'ffv1', '-c:a', 'aac', src,
      ],
      expectAudio: true,
    },
  ];

  it.each(cases)('transcodes $name to playable 8-bit H.264 HLS', async (c) => {
    const dir = mkdtempSync(join(work, 'case-'));
    const src = join(dir, `source.${c.ext ?? 'mp4'}`);
    ffmpeg(c.gen(src));

    const result = await createFfmpegTranscoder().transcode({
      sourcePath: src,
      outputDir: dir,
    });

    // Playlist + at least one segment + a non-empty poster.
    const renditionFiles = readdirSync(join(dir, 'rendition'));
    expect(renditionFiles).toContain('index.m3u8');
    const segment = renditionFiles.find((f) => f.endsWith('.ts'));
    expect(segment).toBeDefined();
    expect(statSync(join(dir, result.posterPath)).size).toBeGreaterThan(0);

    // Output is browser-playable: H.264, 8-bit yuv420p, AAC stereo (or no audio).
    const streams = probeStreams(join(dir, 'rendition', segment!));
    const video = streams.find((s) => s.codec_type === 'video');
    expect(video?.codec_name).toBe('h264');
    expect(video?.pix_fmt).toBe('yuv420p');

    const audio = streams.find((s) => s.codec_type === 'audio');
    if (c.expectAudio) {
      expect(audio?.codec_name).toBe('aac');
      expect(audio?.channels).toBe(2);
    } else {
      expect(audio).toBeUndefined();
    }
  });

  it('selects a single stereo AAC track from a multi-audio source', async () => {
    const dir = mkdtempSync(join(work, 'multiaudio-'));
    const src = join(dir, 'source.mp4');
    // One video + two audio tracks, like a phone's standard + spatial tracks.
    ffmpeg([
      '-f', 'lavfi', '-i', VIDEO('320x240'),
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src,
    ]);
    expect(probeStreams(src).filter((s) => s.codec_type === 'audio')).toHaveLength(2);

    const result = await createFfmpegTranscoder().transcode({
      sourcePath: src,
      outputDir: dir,
    });

    const streams = probeStreams(join(dir, result.playlistPath));
    expect(streams.filter((s) => s.codec_type === 'audio')).toHaveLength(1);
  });

  it('fails with no_video_stream for an audio-only source', async () => {
    const dir = mkdtempSync(join(work, 'audio-only-'));
    const src = join(dir, 'source.m4a');
    ffmpeg(['-f', 'lavfi', '-i', AUDIO, '-c:a', 'aac', src]);

    await expect(
      createFfmpegTranscoder().transcode({ sourcePath: src, outputDir: dir }),
    ).rejects.toMatchObject({ reason: 'no_video_stream' });
  });

  it('reports availability when ffmpeg is present', async () => {
    const status = await createFfmpegTranscoder().checkAvailable();
    expect(status.available).toBe(true);
    expect(status.version).toBeTruthy();
  });

  it('reports unavailable for a missing binary', async () => {
    const status = await createFfmpegTranscoder({
      ffmpegPath: '/nonexistent/ffmpeg',
      ffprobePath: '/nonexistent/ffprobe',
    }).checkAvailable();
    expect(status.available).toBe(false);
    expect(status.error).toBeTruthy();
  });
});
