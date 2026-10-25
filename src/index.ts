import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db/client';
import { systemClock } from './ports/clock';
import { createSlugGenerator } from './ports/slug';
import { createFfmpegTranscoder } from './transcode/ffmpeg-transcoder';
import { runResetPasswordCommand } from './cli/reset-password';

/** Production entrypoint: wire the real collaborators and start listening. */
async function main(): Promise<void> {
  const config = loadConfig();
  const webDistDir =
    config.webDistDir ?? fileURLToPath(new URL('../web/dist', import.meta.url));

  const database = openDatabase(config.dbPath);

  const app = await buildApp({
    db: database.db,
    clock: systemClock,
    slugGenerator: createSlugGenerator(),
    transcoder: createFfmpegTranscoder({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      threads: config.ffmpegThreads,
    }),
    config: { ...config, webDistDir },
    logger: true,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    database.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // eslint-disable-next-line no-console
      console.error(
        `Port ${config.port} is already in use — is another dev server running? ` +
          `Stop it, or set PORT to a free port.`,
      );
      process.exit(1);
    }
    throw err;
  }
  // eslint-disable-next-line no-console
  console.log(`videocastle listening on http://${config.host}:${config.port}`);
}

/**
 * Dispatch: a recognised subcommand (e.g. `reset-password`) runs a one-shot CLI
 * against the datastore and exits; with no subcommand we start the server. This
 * lets an Operator recover a forgotten password with
 * `docker compose exec <svc> node … reset-password <user> <pass>` — no SMTP.
 */
const [, , subcommand, ...rest] = process.argv;

if (subcommand === 'reset-password') {
  runResetPasswordCommand(rest, {
    // eslint-disable-next-line no-console
    out: (line) => console.log(line),
    // eslint-disable-next-line no-console
    err: (line) => console.error(line),
    env: process.env,
  })
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('reset-password failed:', err);
      process.exit(1);
    });
} else {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start videocastle:', err);
    process.exit(1);
  });
}
