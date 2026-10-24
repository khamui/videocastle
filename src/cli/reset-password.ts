import { hashPassword } from '../auth/password';
import { OperatorRepo } from '../auth/operator-repo';
import { loadConfig } from '../config';
import { openDatabase } from '../db/client';

/**
 * Sets a new password for an existing Operator, directly in the datastore. This
 * is the recovery path for a forgotten password (spec: Operator password reset)
 * — no email/SMTP involved, just a privileged write by whoever can run a command
 * against the container. The caller owns the DB; this only touches the row.
 */
export async function resetOperatorPassword(
  repo: OperatorRepo,
  input: { username: string; password: string },
): Promise<void> {
  const password = input.password.trim();
  if (password.length === 0) {
    throw new Error('The new password must not be empty.');
  }
  const operator = await repo.findByUsername(input.username);
  if (!operator) {
    throw new Error(`No Operator named "${input.username}" exists in this instance.`);
  }
  await repo.setPasswordHash(operator.id, await hashPassword(password));
}

/** A console-ish sink, so the command's output is injectable in tests. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
}

const USAGE =
  'Usage: videocastle reset-password <username> [new-password]\n' +
  '  The new password may be given as the second argument, or (to keep it out\n' +
  '  of the process list) via the VIDEOCASTLE_NEW_PASSWORD environment variable.';

/**
 * CLI entrypoint for `reset-password`: resolves the username/password from args
 * and env, opens the configured datastore, applies the reset, and returns a
 * process exit code (0 on success). Runs against the same SQLite file the server
 * uses (WAL + busy_timeout make a concurrent write from the running container
 * safe), so a reset takes effect without a restart.
 */
export async function runResetPasswordCommand(args: string[], io: CliIo): Promise<number> {
  const username = args[0];
  const password = args[1] ?? io.env.VIDEOCASTLE_NEW_PASSWORD;
  if (!username || !password) {
    io.err(USAGE);
    return 2;
  }

  const config = loadConfig(io.env);
  const database = openDatabase(config.dbPath);
  try {
    await resetOperatorPassword(new OperatorRepo(database.db), { username, password });
    io.out(`Password updated for Operator "${username}".`);
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    database.close();
  }
}
