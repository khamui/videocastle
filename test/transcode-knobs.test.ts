import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import {
  buildPosterArgs,
  buildTranscodeArgs,
} from '../src/transcode/ffmpeg-transcoder';
import { buildTestApp, type TestApp } from './helpers';
import { setupOperator, uploadVideo, waitFor } from './support';

/**
 * Host Configuration knobs that bound what transcoding costs the host machine.
 * An instance often shares a VPS with other services, so its owner must be able
 * to turn transcoding down without touching the code.
 */

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** A signed-in app built with the given Host Configuration environment. */
async function signedIn(
  env: NodeJS.ProcessEnv = {},
): Promise<TestApp & { jar: Record<string, string> }> {
  current = await buildTestApp({ env });
  return { ...current, jar: await setupOperator(current.app) };
}

function upload(
  app: TestApp['app'],
  jar: Record<string, string>,
  title: string,
): Promise<unknown> {
  return uploadVideo(app, jar, {
    fields: { title },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
  });
}

describe('TRANSCODE_CONCURRENCY', () => {
  it('defaults to 2, the value that was hardcoded before it was configurable', () => {
    expect(loadConfig({}).transcodeConcurrency).toBe(2);
  });

  it('falls back to the default rather than wedging the worker on a nonsense value', () => {
    // A 0 or negative concurrency would mean nothing is ever pumped: uploads
    // would sit in Processing forever with no error anywhere.
    for (const value of ['0', '-1', 'two', '']) {
      expect(loadConfig({ TRANSCODE_CONCURRENCY: value }).transcodeConcurrency).toBe(2);
    }
  });

  it('runs two transcodes at once by default', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false; // hold both jobs open so we can count them

    await upload(app, jar, 'One');
    await upload(app, jar, 'Two');

    await waitFor(() => transcoder.requests.length === 2);
  });

  it('runs one transcode at a time when set to 1, queueing the rest', async () => {
    const { app, jar, transcoder, worker } = await signedIn({
      TRANSCODE_CONCURRENCY: '1',
    });
    transcoder.auto = false;

    await upload(app, jar, 'One');
    await upload(app, jar, 'Two');
    await waitFor(() => transcoder.requests.length === 1);

    // The second Video is queued, not running: give the worker room to start it
    // and confirm it doesn't.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transcoder.requests).toHaveLength(1);

    // Finishing the first lets the queued one through.
    await transcoder.complete();
    await waitFor(() => transcoder.requests.length === 2);
    await transcoder.complete();
    await worker.idle();
  });
});

describe('FFMPEG_THREADS', () => {
  it('is unset by default, leaving ffmpeg its own choice', () => {
    expect(loadConfig({}).ffmpegThreads).toBeUndefined();
  });

  it('ignores a value that is not a positive integer', () => {
    for (const value of ['0', '-4', 'all', '']) {
      expect(loadConfig({ FFMPEG_THREADS: value }).ffmpegThreads).toBeUndefined();
    }
  });

  it('reads a positive integer', () => {
    expect(loadConfig({ FFMPEG_THREADS: '3' }).ffmpegThreads).toBe(3);
  });

  it('passes no -threads flag when uncapped', () => {
    const args = buildTranscodeArgs({
      sourcePath: '/media/1/source',
      renditionDir: '/media/1/rendition',
      isHdr: false,
    });
    expect(args).not.toContain('-threads');
    expect(
      buildPosterArgs({
        sourcePath: '/media/1/source',
        posterPath: '/media/1/poster.jpg',
        atSeconds: 1.5,
        isHdr: false,
      }),
    ).not.toContain('-threads');
  });

  it('caps both the decoder and the encoder when set', () => {
    const args = buildTranscodeArgs({
      sourcePath: '/media/1/source',
      renditionDir: '/media/1/rendition',
      isHdr: false,
      threads: 2,
    });

    // Once before `-i` (the decoder) and once after it (the encoder): capping
    // only the encoder leaves decoding free to use every core.
    const before = args.slice(0, args.indexOf('-i'));
    const after = args.slice(args.indexOf('-i'));
    expect(before).toContain('-threads');
    expect(after).toContain('-threads');
    expect(args.filter((a) => a === '-threads')).toHaveLength(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-threads') expect(args[i + 1]).toBe('2');
    }
  });

  it('caps the poster grab too, HDR tone-mapping included', () => {
    for (const isHdr of [false, true]) {
      const args = buildPosterArgs({
        sourcePath: '/media/1/source',
        posterPath: '/media/1/poster.jpg',
        atSeconds: 1.5,
        isHdr,
        threads: 1,
      });
      expect(args.filter((a) => a === '-threads')).toHaveLength(2);
      expect(args[args.indexOf('-threads') + 1]).toBe('1');
    }
  });
});
