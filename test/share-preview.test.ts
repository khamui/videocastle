import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers';
import { setupOperator, uploadVideo } from './support';
import { escapeHtml, injectShareMeta } from '../src/videos/share-preview';

/** A stand-in for the built Vite shell, enough for the injector to work on. */
const SHELL = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <title>videocastle</title>',
  '  </head>',
  '  <body><div id="root"></div></body>',
  '</html>',
].join('\n');

describe('injectShareMeta', () => {
  it('returns the shell untouched for the generic (null) case', () => {
    expect(injectShareMeta(SHELL, null)).toBe(SHELL);
  });

  it('injects og/twitter title and rewrites <title> for a title-only target', () => {
    const out = injectShareMeta(SHELL, { title: 'Weekly sync', description: null });
    expect(out).toContain('<meta property="og:title" content="Weekly sync" />');
    expect(out).toContain('<meta name="twitter:title" content="Weekly sync" />');
    expect(out).toContain('<title>Weekly sync</title>');
    expect(out).not.toContain('<title>videocastle</title>');
    // No description → no description tags, and never an image.
    expect(out).not.toContain('og:description');
    expect(out).not.toContain('og:image');
  });

  it('includes description tags when a description is present', () => {
    const out = injectShareMeta(SHELL, { title: 'Demo', description: 'a quick look' });
    expect(out).toContain('<meta property="og:description" content="a quick look" />');
    expect(out).toContain('<meta name="description" content="a quick look" />');
    expect(out).toContain('<meta name="twitter:description" content="a quick look" />');
  });

  it('escapes HTML so an Operator title cannot inject markup', () => {
    const out = injectShareMeta(SHELL, {
      title: '<script>"x"',
      description: 'a & b',
    });
    expect(out).toContain('content="&lt;script&gt;&quot;x&quot;"');
    expect(out).toContain('content="a &amp; b"');
    expect(out).not.toContain('<script>"x"');
  });
});

describe('escapeHtml', () => {
  it('escapes the five markup-significant characters', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });
});

describe('Share-Link previews served from /v and /f', () => {
  let current: (TestApp & { jar: Record<string, string> }) | undefined;
  let distDir: string | undefined;

  afterEach(async () => {
    await current?.close();
    current = undefined;
    if (distDir) rmSync(distDir, { recursive: true, force: true });
    distDir = undefined;
  });

  /** Boots an app with a real (temp) web dist, so the preview routes register. */
  async function signedInWithWeb(): Promise<TestApp & { jar: Record<string, string> }> {
    distDir = mkdtempSync(join(tmpdir(), 'vc-dist-'));
    writeFileSync(join(distDir, 'index.html'), SHELL);
    const app = await buildTestApp({ env: { WEB_DIST_DIR: distDir } });
    current = { ...app, jar: await setupOperator(app.app) };
    return current;
  }

  async function uploadReady(
    t: TestApp & { jar: Record<string, string> },
    fields: Record<string, string>,
  ): Promise<string> {
    const up = await uploadVideo(t.app, t.jar, {
      fields,
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await t.worker.idle();
    return up.json().video.slug as string;
  }

  const html = (t: TestApp, url: string) => t.app.inject({ method: 'GET', url });

  it('shows a Ready, unprotected Video’s title (and description)', async () => {
    const t = await signedInWithWeb();
    const slug = await uploadReady(t, { title: 'My Interview', description: 'a chat' });

    const res = await html(t, `/v/${slug}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<meta property="og:title" content="My Interview" />');
    expect(res.body).toContain('<meta property="og:description" content="a chat" />');
    expect(res.body).toContain('<title>My Interview</title>');
    // Text only — the Viewer's privacy posture (ADR-0012): never an image.
    expect(res.body).not.toContain('og:image');
  });

  it('escapes an Operator title end-to-end', async () => {
    const t = await signedInWithWeb();
    const slug = await uploadReady(t, { title: 'Q4 <strong> "review"' });

    const res = await html(t, `/v/${slug}`);
    expect(res.body).toContain('content="Q4 &lt;strong&gt; &quot;review&quot;"');
    expect(res.body).not.toContain('Q4 <strong> "review"');
  });

  it('stays generic for a password-protected Video (no title leak)', async () => {
    const t = await signedInWithWeb();
    const slug = await uploadReady(t, { title: 'Secret briefing' });
    await t.app.inject({
      method: 'POST',
      url: `/api/videos/${slug}/password`,
      cookies: t.jar,
      payload: { password: 'open sesame' },
    });

    const res = await html(t, `/v/${slug}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('og:title');
    expect(res.body).not.toContain('Secret briefing');
    expect(res.body).toContain('<title>videocastle</title>');
  });

  it('stays generic for an expired Video', async () => {
    const t = await signedInWithWeb();
    const slug = await uploadReady(t, { title: 'Yesterday' });
    await t.app.inject({
      method: 'POST',
      url: `/api/videos/${slug}/expiry`,
      cookies: t.jar,
      payload: { expiresAt: t.clock.now() - 1000 },
    });

    const res = await html(t, `/v/${slug}`);
    expect(res.body).not.toContain('og:title');
    expect(res.body).not.toContain('Yesterday');
  });

  it('stays generic for an unknown slug', async () => {
    const t = await signedInWithWeb();
    const res = await html(t, '/v/does-not-exist');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('og:title');
  });

  it('shows an open Folder’s name, but stays generic when it is protected', async () => {
    const t = await signedInWithWeb();
    const open = await t.app.inject({
      method: 'POST',
      url: '/api/folders',
      cookies: t.jar,
      payload: { name: 'Team Reel' },
    });
    const openSlug = open.json().folder.slug as string;

    const protectedFolder = await t.app.inject({
      method: 'POST',
      url: '/api/folders',
      cookies: t.jar,
      payload: { name: 'Board Only' },
    });
    const protSlug = protectedFolder.json().folder.slug as string;
    await t.app.inject({
      method: 'POST',
      url: `/api/folders/${protSlug}/password`,
      cookies: t.jar,
      payload: { password: 'locked' },
    });

    const openRes = await html(t, `/f/${openSlug}`);
    expect(openRes.body).toContain('<meta property="og:title" content="Team Reel" />');

    const protRes = await html(t, `/f/${protSlug}`);
    expect(protRes.body).not.toContain('og:title');
    expect(protRes.body).not.toContain('Board Only');
  });
});
