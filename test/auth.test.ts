import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers';

type InjectResponse = Awaited<ReturnType<TestApp['app']['inject']>>;

let current: TestApp | undefined;

async function makeApp(env?: NodeJS.ProcessEnv): Promise<TestApp> {
  current = await buildTestApp({ env });
  return current;
}

afterEach(async () => {
  await current?.close();
  current = undefined;
});

const VALID: { username: string; password: string } = {
  username: 'operator',
  password: 'correct horse battery',
};

/** Completes first-run setup and returns the session cookie jar it set. */
async function setup(
  app: TestApp['app'],
  creds = VALID,
): Promise<Record<string, string>> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: creds,
  });
  expect(res.statusCode).toBe(201);
  return cookieJar(res);
}

/** Extracts a name→value cookie jar from a response's Set-Cookie headers. */
function cookieJar(res: InjectResponse): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const cookie of res.cookies) {
    jar[cookie.name] = cookie.value;
  }
  return jar;
}

describe('first-run setup', () => {
  it('reports that setup is needed on a fresh instance', async () => {
    const { app } = await makeApp();

    const res = await app.inject({ method: 'GET', url: '/api/setup' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: true });
  });

  it('creates the Operator, stamping createdAt from the injected clock', async () => {
    const { app, clock } = await makeApp();
    clock.set(1_234_567_890_000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'operator', password: 'correct horse battery' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      operator: { username: 'operator', createdAt: 1_234_567_890_000 },
    });

    const after = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(after.json()).toEqual({ needsSetup: false });
  });

  it('rejects a second setup once an Operator exists', async () => {
    const { app } = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'operator', password: 'correct horse battery' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'intruder', password: 'another password here' },
    });

    expect(res.statusCode).toBe(409);
  });

  it('rejects setup with a too-short password and creates no Operator', async () => {
    const { app } = await makeApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'operator', password: 'short' },
    });

    expect(res.statusCode).toBe(400);
    const after = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(after.json()).toEqual({ needsSetup: true });
  });

  it('never stores the password in plaintext', async () => {
    const { app, db } = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'operator', password: 'correct horse battery' },
    });

    const stored = db.raw
      .prepare('SELECT password_hash FROM operators')
      .get() as { password_hash: string };
    expect(stored.password_hash).not.toContain('correct horse battery');
    expect(stored.password_hash.startsWith('scrypt$')).toBe(true);
  });
});

describe('sign-in & sessions', () => {
  it('signs in with correct credentials and sets an httpOnly session cookie', async () => {
    const { app } = await makeApp();
    await setup(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: VALID,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ operator: { username: 'operator' } });

    const session = res.cookies.find((c) => c.name === 'vc_session');
    expect(session).toBeDefined();
    expect(session!.httpOnly).toBe(true);
    expect(session!.value.length).toBeGreaterThan(0);
  });

  it('rejects a wrong password without setting a session cookie', async () => {
    const { app } = await makeApp();
    await setup(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { username: 'operator', password: 'wrong password entirely' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === 'vc_session')).toBeUndefined();
  });

  it('rejects an unknown username', async () => {
    const { app } = await makeApp();
    await setup(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { username: 'nobody', password: 'correct horse battery' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('serves the operator-only route only to an authenticated session', async () => {
    const { app } = await makeApp();
    const jar = await setup(app);

    const unauthed = await app.inject({ method: 'GET', url: '/api/me' });
    expect(unauthed.statusCode).toBe(401);

    const authed = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: jar,
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toMatchObject({ operator: { username: 'operator' } });
  });

  it('rejects a tampered session cookie', async () => {
    const { app } = await makeApp();
    await setup(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { vc_session: 'not-a-valid-signed-value' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('signs out, after which the operator-only route is rejected again', async () => {
    const { app } = await makeApp();
    const jar = await setup(app);

    const signOut = await app.inject({
      method: 'DELETE',
      url: '/api/session',
      cookies: jar,
    });
    expect(signOut.statusCode).toBe(204);

    // The sign-out response clears the cookie; a request carrying the cleared
    // jar is no longer authenticated.
    const cleared = cookieJar(signOut);
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: cleared,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('session persistence across restarts', () => {
  it('keeps a session valid after the app is rebuilt over the same data', async () => {
    const first = await buildTestApp();
    const jar = await setup(first.app);
    await first.app.close();

    // Rebuild a fresh app over the *same* database handle: the signing secret
    // was persisted on first run, so the earlier cookie still validates.
    const second = await buildTestApp({ db: first.db });
    current = second;
    try {
      const res = await second.app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: jar,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ operator: { username: 'operator' } });
    } finally {
      first.db.close();
    }
  });

  it('invalidates sessions when a different signing secret is configured', async () => {
    const first = await buildTestApp({ env: { SESSION_SECRET: 'secret-one' } });
    const jar = await setup(first.app);
    await first.app.close();

    const second = await buildTestApp({
      db: first.db,
      env: { SESSION_SECRET: 'secret-two' },
    });
    current = second;
    try {
      const res = await second.app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: jar,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      first.db.close();
    }
  });
});
