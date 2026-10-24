import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db/client';
import { systemClock } from './ports/clock';
import { createSlugGenerator } from './ports/slug';
import { ffmpegTranscoder } from './transcode/ffmpeg-transcoder';

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
    transcoder: ffmpegTranscoder,
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

  await app.listen({ host: config.host, port: config.port });
  // eslint-disable-next-line no-console
  console.log(`videocastle listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start videocastle:', err);
  process.exit(1);
});
