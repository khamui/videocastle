import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscodeError } from '../src/ports/transcoder';
import { buildTestApp, type TestApp } from './helpers';
import { setupOperator, uploadVideo, waitFor } from './support';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** Builds an app, completes first-run setup, and returns it plus the session jar. */
async function signedIn(): Promise<TestApp & { jar: Record<string, string> }> {
  current = await buildTestApp();
  return { ...current, jar: await setupOperator(current.app) };
}

/**
 * Writes the Rendition + Poster files the real transcoder would have produced,
 * so the public media routes have something to serve. (The fake Transcoder
 * flips state to Ready without touching disk.) Returns the Video's media dir.
 */
function writeRendition(
  mediaDir: string,
  files: { playlist: string; segment: string; poster: string },
): string {
  const [id] = readdirSync(mediaDir);
  const dir = join(mediaDir, id!);
  mkdirSync(join(dir, 'rendition'), { recursive: true });
  writeFileSync(join(dir, 'rendition', 'index.m3u8'), files.playlist);
  writeFileSync(join(dir, 'rendition', 'seg_000.ts'), files.segment);
  writeFileSync(join(dir, 'poster.jpg'), files.poster);
  return dir;
}

/** Uploads a clip and waits for the (auto) fake transcoder to drive it to Ready. */
async function uploadReady(app: TestApp): Promise<void> {
  const jar = await setupOperator(app.app);
  await uploadVideo(app.app, jar, {
    fields: { title: 'My Interview', description: 'a chat' },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
  });
  await app.worker.idle();
}

describe('watching a Video via /v/<slug>', () => {
  it('serves a Ready Video’s watch view with poster and playlist URLs', async () => {
    current = await buildTestApp();
    await uploadReady(current);

    const res = await current.app.inject({ method: 'GET', url: '/api/watch/slug-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json().watch).toMatchObject({
      state: 'ready',
      title: 'My Interview',
      description: 'a chat',
      playlistUrl: '/api/watch/slug-1/stream/index.m3u8',
      posterUrl: '/api/watch/slug-1/poster.jpg',
    });
  });

  it('plays via HLS: serves the playlist, its segments, and the poster publicly', async () => {
    current = await buildTestApp();
    await uploadReady(current);
    writeRendition(current.config.mediaDir, {
      playlist: '#EXTM3U\n#EXT-X-VERSION:3\nseg_000.ts\n',
      segment: 'TS-BYTES',
      poster: 'JPEG-BYTES',
    });

    const playlist = await current.app.inject({
      method: 'GET',
      url: '/api/watch/slug-1/stream/index.m3u8',
    });
    expect(playlist.statusCode).toBe(200);
    expect(playlist.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(playlist.body).toContain('seg_000.ts');

    const segment = await current.app.inject({
      method: 'GET',
      url: '/api/watch/slug-1/stream/seg_000.ts',
    });
    expect(segment.statusCode).toBe(200);
    expect(segment.headers['content-type']).toContain('video/mp2t');
    expect(segment.body).toBe('TS-BYTES');

    const poster = await current.app.inject({
      method: 'GET',
      url: '/api/watch/slug-1/poster.jpg',
    });
    expect(poster.statusCode).toBe(200);
    expect(poster.headers['content-type']).toContain('image/jpeg');
    expect(poster.body).toBe('JPEG-BYTES');
  });

  it('needs no Operator session to watch (possession of the link is the permission)', async () => {
    current = await buildTestApp();
    await uploadReady(current);
    writeRendition(current.config.mediaDir, {
      playlist: '#EXTM3U\n',
      segment: 'x',
      poster: 'y',
    });

    // No cookies supplied at all.
    const view = await current.app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(view.statusCode).toBe(200);
    const playlist = await current.app.inject({
      method: 'GET',
      url: '/api/watch/slug-1/stream/index.m3u8',
    });
    expect(playlist.statusCode).toBe(200);
  });

  it('tells a Viewer a still-Processing Video is being prepared, not an error', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false; // hold it in Processing

    await uploadVideo(app, jar, {
      fields: { title: 'Rendering clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await waitFor(() => transcoder.requests.length === 1);

    const res = await app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().watch).toMatchObject({ state: 'processing', title: 'Rendering clip' });

    // Not playable yet: the stream is not served while Processing.
    const playlist = await app.inject({
      method: 'GET',
      url: '/api/watch/slug-1/stream/index.m3u8',
    });
    expect(playlist.statusCode).toBe(404);
  });

  it('returns a generic 404 for an unknown slug (no existence leak)', async () => {
    current = await buildTestApp();
    await uploadReady(current);

    const view = await current.app.inject({ method: 'GET', url: '/api/watch/nope-nope' });
    expect(view.statusCode).toBe(404);
    expect(view.json()).toEqual({ error: 'not_found' });

    const playlist = await current.app.inject({
      method: 'GET',
      url: '/api/watch/nope-nope/stream/index.m3u8',
    });
    expect(playlist.statusCode).toBe(404);
  });

  it('reports a Failed Video as a neutral state, leaking no Operator diagnostics', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    transcoder.auto = false;

    await uploadVideo(app, jar, {
      fields: { title: 'Doomed clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await waitFor(() => transcoder.requests.length === 1);
    await transcoder.fail(new TranscodeError('encode_failed', 'boom', 'ffmpeg stderr'));
    await worker.idle();

    // GLOSSARY: a Failed Video shows a neutral "temporarily unavailable" — a
    // distinct, resolvable state (not the existence-hiding 404), but it must
    // carry none of the Operator's failure reason/detail/title (ADR-0007).
    const res = await app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().watch).toEqual({ state: 'failed' });
    expect(res.body).not.toContain('encode_failed');
    expect(res.body).not.toContain('ffmpeg');
    expect(res.body).not.toContain('Doomed clip');

    // Still nothing to play.
    const playlist = await app.inject({
      method: 'GET',
      url: '/api/watch/slug-1/stream/index.m3u8',
    });
    expect(playlist.statusCode).toBe(404);
  });

  it('rejects a media filename outside the Rendition (no path traversal)', async () => {
    current = await buildTestApp();
    await uploadReady(current);
    writeRendition(current.config.mediaDir, {
      playlist: '#EXTM3U\n',
      segment: 'x',
      poster: 'y',
    });

    for (const bad of ['..%2f..%2fsource', 'source', 'evil.ts', 'seg_000.txt']) {
      const res = await current.app.inject({
        method: 'GET',
        url: `/api/watch/slug-1/stream/${bad}`,
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
