import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OperatorRepo } from '../src/auth/operator-repo';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { openDatabase } from '../src/db/client';
import { resetOperatorPassword, runResetPasswordCommand, type CliIo } from '../src/cli/reset-password';
import { buildTestApp, type TestApp } from './helpers';
import { OPERATOR, setupOperator } from './support';

let current: TestApp | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh, migrated, file-backed datastore (so a second CLI connection can open it). */
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-cli-'));
  tempDirs.push(dir);
  return join(dir, 'videocastle.db');
}

function fakeIo(env: NodeJS.ProcessEnv): CliIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { out: (l) => outs.push(l), err: (l) => errs.push(l), env, outs, errs };
}

describe('operator password reset', () => {
  it('replaces the credential: the old password stops working and the new one signs in', async () => {
    current = await buildTestApp();
    await setupOperator(current.app);

    await resetOperatorPassword(new OperatorRepo(current.db.db), {
      username: OPERATOR.username,
      password: 'a brand new secret',
    });

    // Driven through the real sign-in boundary: old rejected, new accepted.
    const oldAttempt = await current.app.inject({ method: 'POST', url: '/api/session', payload: OPERATOR });
    expect(oldAttempt.statusCode).toBe(401);

    const newAttempt = await current.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { username: OPERATOR.username, password: 'a brand new secret' },
    });
    expect(newAttempt.statusCode).toBe(200);
  });

  it('rejects an empty new password and an unknown Operator', async () => {
    current = await buildTestApp();
    await setupOperator(current.app);
    const repo = new OperatorRepo(current.db.db);

    await expect(
      resetOperatorPassword(repo, { username: OPERATOR.username, password: '   ' }),
    ).rejects.toThrow(/must not be empty/);
    await expect(
      resetOperatorPassword(repo, { username: 'nobody', password: 'x' }),
    ).rejects.toThrow(/No Operator named "nobody"/);
  });
});

describe('the reset-password CLI command', () => {
  it('sets the password in the configured datastore and reports success (exit 0)', async () => {
    const dbPath = tempDbPath();
    const seed = openDatabase(dbPath);
    await new OperatorRepo(seed.db).create({
      username: 'alice',
      passwordHash: await hashPassword('old password'),
      createdAt: 1,
    });
    seed.close();

    const io = fakeIo({ DB_PATH: dbPath });
    const code = await runResetPasswordCommand(['alice', 'fresh password'], io);
    expect(code).toBe(0);
    expect(io.outs.join('\n')).toMatch(/Password updated for Operator "alice"/);

    // Re-open the file: the new password verifies, the old no longer does.
    const check = openDatabase(dbPath);
    const alice = await new OperatorRepo(check.db).findByUsername('alice');
    expect(await verifyPassword('fresh password', alice!.passwordHash)).toBe(true);
    expect(await verifyPassword('old password', alice!.passwordHash)).toBe(false);
    check.close();
  });

  it('reads the new password from VIDEOCASTLE_NEW_PASSWORD when no arg is given', async () => {
    const dbPath = tempDbPath();
    const seed = openDatabase(dbPath);
    await new OperatorRepo(seed.db).create({
      username: 'bob',
      passwordHash: await hashPassword('old'),
      createdAt: 1,
    });
    seed.close();

    const code = await runResetPasswordCommand(
      ['bob'],
      fakeIo({ DB_PATH: dbPath, VIDEOCASTLE_NEW_PASSWORD: 'from the env' }),
    );
    expect(code).toBe(0);

    const check = openDatabase(dbPath);
    const bob = await new OperatorRepo(check.db).findByUsername('bob');
    expect(await verifyPassword('from the env', bob!.passwordHash)).toBe(true);
    check.close();
  });

  it('prints usage and exits 2 when the username or password is missing', async () => {
    const io = fakeIo({});
    expect(await runResetPasswordCommand([], io)).toBe(2);
    expect(io.errs.join('\n')).toMatch(/Usage: videocastle reset-password/);
  });

  it('exits 1 with a clear message for an unknown Operator', async () => {
    const dbPath = tempDbPath(); // migrated but empty — no Operator
    const io = fakeIo({ DB_PATH: dbPath });
    const code = await runResetPasswordCommand(['ghost', 'whatever'], io);
    expect(code).toBe(1);
    expect(io.errs.join('\n')).toMatch(/No Operator named "ghost"/);
  });

  it('introduces no email/SMTP dependency', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(names.some((n) => /mail|smtp|sendgrid|nodemailer|ses/i.test(n))).toBe(false);
  });
});
