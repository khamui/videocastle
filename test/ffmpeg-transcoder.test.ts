import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfmpegTranscoder } from '../src/transcode/ffmpeg-transcoder';

/**
 * The one slow, external, nondeterministic piece: validated lightly against a
 * real ffmpeg and skipped entirely where ffmpeg/ffprobe aren't installed, so
 * the behavioural suite stays fast and hermetic.
 */
const hasFfmpeg = onPath('ffmpeg') && onPath('ffprobe');
const describeFfmpeg = hasFfmpeg ? describe : describe.skip;

function onPath(binary: string): boolean {
  const probe = spawnSync(binary, ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

describeFfmpeg('ffmpeg transcoder (requires ffmpeg on PATH)', () => {
  let workDir: string;
  let sourcePath: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'vc-ffmpeg-'));
    sourcePath = join(workDir, 'source');
    // A ~1s synthetic clip with video + audio, written to the Source path.
    const gen = spawnSync(
      'ffmpeg',
      [
        '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-shortest', '-pix_fmt', 'yuv420p', '-f', 'mp4', sourcePath,
      ],
      { stdio: 'ignore' },
    );
    if (gen.status !== 0) throw new Error('failed to generate test clip');
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('produces an HLS playlist, at least one segment, and a poster', async () => {
    const outputDir = join(workDir, 'out');
    writeFileSync(join(workDir, '.keep'), '');

    const progress: number[] = [];
    const result = await createFfmpegTranscoder().transcode({
      sourcePath,
      outputDir,
      onProgress: (pct) => void progress.push(pct),
    });

    expect(result.playlistPath).toBe(join('rendition', 'index.m3u8'));
    expect(result.posterPath).toBe('poster.jpg');
    expect(result.durationSeconds).toBeGreaterThanOrEqual(1);

    const renditionFiles = readdirSync(join(outputDir, 'rendition'));
    expect(renditionFiles).toContain('index.m3u8');
    expect(renditionFiles.some((f) => f.endsWith('.ts'))).toBe(true);
    expect(statSync(join(outputDir, 'poster.jpg')).size).toBeGreaterThan(0);
  });
});
