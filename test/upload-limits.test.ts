import { readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildTestApp, type TestApp } from './helpers';
import { multipart, setupOperator } from './support';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** A signed-in app whose upload cap is `maxBytes` (a tiny value, for testing). */
async function signedInWithCap(
  maxBytes: number,
): Promise<TestApp & { jar: Record<string, string> }> {
  current = await buildTestApp({ env: { MAX_UPLOAD_BYTES: String(maxBytes) } });
  return { ...current, jar: await setupOperator(current.app) };
}

/** How many Video media directories exist on disk (one per created Video). */
function mediaDirCount(mediaDir: string): number {
  return readdirSync(mediaDir).length;
}

describe('upload size limit', () => {
  it('has a sensible default cap when MAX_UPLOAD_BYTES is unset', () => {
    expect(loadConfig({}).maxUploadBytes).toBe(2 * 1024 ** 3); // 2 GiB
  });

  it('rejects an over-cap upload up front via Content-Length, writing nothing', async () => {
    const { app, jar, config } = await signedInWithCap(50);
    const { payload, headers } = multipart({
      fields: { title: 'Huge' },
      file: { fieldname: 'file', filename: 'big.mp4', content: 'x'.repeat(500) },
    });

    const res = await app.inject({ method: 'POST', url: '/api/videos', cookies: jar, headers, payload });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'upload_too_large' });
    expect(res.json().detail).toMatch(/over the 50-byte/);
    // Rejected before anything was written: no Video row, no media directory.
    expect(mediaDirCount(config.mediaDir)).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/videos', cookies: jar })).json().videos).toHaveLength(0);
  });

  it('rejects an over-cap upload mid-stream when no honest Content-Length is given', async () => {
    const { app, jar, config } = await signedInWithCap(50);
    const { payload, headers } = multipart({
      fields: { title: 'Sneaky' },
      file: { fieldname: 'file', filename: 'big.mp4', content: 'x'.repeat(500) },
    });

    // Send the body as a stream so light-my-request sends it chunked, with no
    // Content-Length — the early check can't fire, so the mid-stream file-size
    // limit must catch it, truncate, and roll back the partial Source.
    const res = await app.inject({
      method: 'POST',
      url: '/api/videos',
      cookies: jar,
      headers,
      payload: Readable.from(payload),
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'upload_too_large' });
    expect(res.json().detail).toMatch(/exceeds the 50-byte/);
    // The partial Source and its row were rolled back — no debris left behind.
    expect(mediaDirCount(config.mediaDir)).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/videos', cookies: jar })).json().videos).toHaveLength(0);
  });

  it('accepts an upload within the cap', async () => {
    const { app, jar } = await signedInWithCap(10_000);
    const { payload, headers } = multipart({
      fields: { title: 'Fine' },
      file: { fieldname: 'file', filename: 'ok.mp4', content: 'x'.repeat(200) },
    });

    const res = await app.inject({ method: 'POST', url: '/api/videos', cookies: jar, headers, payload });
    expect(res.statusCode).toBe(201);
    expect(res.json().video).toMatchObject({ title: 'Fine', state: 'processing' });
  });
});
