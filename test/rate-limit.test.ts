import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildTestApp, type TestApp } from './helpers';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function appWith(env: NodeJS.ProcessEnv): Promise<TestApp> {
  current = await buildTestApp({ env });
  return current;
}

/** A distinct client IP, delivered via X-Forwarded-For (the app trusts the proxy). */
const from = (ip: string) => ({ 'x-forwarded-for': ip });

describe('rate limiting the public Viewer surface', () => {
  it('has sensible, configurable defaults', () => {
    const c = loadConfig({});
    expect(c.rateLimitWindowMs).toBe(60_000);
    expect(c.rateLimitMax).toBe(600);
    expect(c.rateLimitPasswordMax).toBe(10);
  });

  it('applies a general per-IP limit to public viewer endpoints', async () => {
    const app = await appWith({ RATE_LIMIT_MAX: '3', RATE_LIMIT_PASSWORD_MAX: '100' });
    const ip = from('9.9.9.9');

    for (let i = 0; i < 3; i++) {
      const res = await app.app.inject({ method: 'GET', url: '/api/watch/whatever', headers: ip });
      expect(res.statusCode).not.toBe(429); // within the limit (a 404, but allowed)
    }
    const blocked = await app.app.inject({ method: 'GET', url: '/api/watch/whatever', headers: ip });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'rate_limited' });
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('throttles password attempts (Video + Folder) with a stricter, shared per-IP limit', async () => {
    const app = await appWith({ RATE_LIMIT_MAX: '1000', RATE_LIMIT_PASSWORD_MAX: '2' });
    const ip = from('8.8.8.8');
    const unlockVideo = () =>
      app.app.inject({ method: 'POST', url: '/api/watch/none/unlock', headers: ip, payload: { password: 'x' } });
    const unlockFolder = () =>
      app.app.inject({ method: 'POST', url: '/api/watch/folder/none/unlock', headers: ip, payload: { password: 'x' } });

    // Two attempts allowed, drawn from one shared bucket across Video and Folder…
    expect((await unlockVideo()).statusCode).not.toBe(429);
    expect((await unlockFolder()).statusCode).not.toBe(429);
    // …the third attempt (either surface) is throttled, well under the general cap.
    expect((await unlockVideo()).statusCode).toBe(429);
  });

  it('keys the limit per IP, so one client cannot exhaust another’s budget', async () => {
    const app = await appWith({ RATE_LIMIT_MAX: '1' });

    expect((await app.app.inject({ method: 'GET', url: '/api/watch/x', headers: from('1.1.1.1') })).statusCode).not.toBe(429);
    expect((await app.app.inject({ method: 'GET', url: '/api/watch/x', headers: from('1.1.1.1') })).statusCode).toBe(429);
    // A different IP starts with a fresh budget.
    expect((await app.app.inject({ method: 'GET', url: '/api/watch/x', headers: from('2.2.2.2') })).statusCode).not.toBe(429);
  });

  it('resets the budget once the window elapses', async () => {
    const app = await appWith({ RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_MS: '1000' });
    const ip = from('3.3.3.3');

    expect((await app.app.inject({ method: 'GET', url: '/api/watch/x', headers: ip })).statusCode).not.toBe(429);
    expect((await app.app.inject({ method: 'GET', url: '/api/watch/x', headers: ip })).statusCode).toBe(429);

    app.clock.advance(1000); // the window has fully elapsed
    expect((await app.app.inject({ method: 'GET', url: '/api/watch/x', headers: ip })).statusCode).not.toBe(429);
  });

  it('leaves the Operator/SPA surface un-throttled (only /api/watch is public-facing)', async () => {
    const app = await appWith({ RATE_LIMIT_MAX: '1' });
    const ip = from('4.4.4.4');
    for (let i = 0; i < 5; i++) {
      const res = await app.app.inject({ method: 'GET', url: '/api/setup', headers: ip });
      expect(res.statusCode).not.toBe(429);
    }
  });
});
