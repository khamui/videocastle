/**
 * Records the README's demo GIF: a real instance driven through the whole arc —
 * first-run setup, upload, transcode, Share Link, Watch Page — in a scripted
 * browser, then converted to a GIF with ffmpeg.
 *
 * This is marketing media, not a test. It lives outside `test/` deliberately: a
 * flaky recorder must never be able to fail the test suite. Nothing it produces
 * except `docs/images/demo.gif` is committed — the clip it uploads is generated
 * by ffmpeg at run time, and the instance it drives is a throwaway under
 * `DATA_DIR` in a temp directory.
 *
 * Run it from the dev shell (which supplies ffmpeg):  npm run demo:gif
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';

/** Where the finished GIF lands — the path the README points at. */
const OUT = path.resolve('docs/images/demo.gif');
/** GitHub clones carry this forever, so the budget is tight on purpose. */
const MAX_BYTES = 3 * 1024 * 1024;
const OPERATOR = { username: 'operator', password: 'demo-password-9271' };

/**
 * The port appears on camera in the Share Link, so prefer the one the docs tell
 * people to open. A dev server of your own already on 8080 is the common case
 * though, and the demo must never drive *that* instance — it has your real
 * Library in it — so fall back rather than collide.
 */
async function pickPort(): Promise<number> {
  const preferred = Number(process.env.PORT ?? 8080);
  for (const port of [preferred, 8081, 8082, 8083]) {
    if (await isFree(port)) return port;
  }
  throw new Error('No free port found for the demo instance');
}

async function isFree(port: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const server = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => server.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `${cmd} exited ${res.status}\n${res.stderr?.toString() ?? ''}`,
    );
  }
}

/**
 * Playwright's bundled Chromium is dynamically linked against libraries NixOS
 * does not put where it looks (libudev.so.1 and friends), so prefer a browser
 * the host already has. `DEMO_BROWSER` overrides the search.
 */
function resolveBrowser(): string | undefined {
  const explicit = process.env.DEMO_BROWSER;
  if (explicit) return explicit;
  const candidates = [
    '/run/current-system/sw/bin/google-chrome-stable',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((c) => existsSync(c));
}

/** A font for ffmpeg's drawtext; fontconfig knows where it is, we don't. */
function resolveFont(): string {
  const res = spawnSync('fc-match', ['-f', '%{file}', 'DejaVu Sans:bold'], {
    encoding: 'utf8',
  });
  const file = res.stdout?.trim();
  if (file && existsSync(file)) return file;
  throw new Error(
    'No font found for ffmpeg drawtext — set one via fontconfig or edit resolveFont().',
  );
}

/**
 * The clip the demo uploads. Generated rather than committed: the repo holds no
 * video file, and nothing is downloaded. A moving timecode is the point — it is
 * what proves on camera that the Video is really playing rather than showing a
 * frozen Poster.
 */
function generateClip(dest: string): void {
  const font = resolveFont().replace(/:/g, '\\:');
  run(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    // A *static* background with a moving timecode on top. An animated one
    // looks better in isolation and is a disaster in the GIF: every pixel
    // changes every frame while the Video plays, which tripled the file and
    // forced the converter to drop resolution and frames to compensate. The
    // timecode alone is enough to prove the Video is really playing.
    '-i', 'gradients=s=1280x720:c0=0x1d2b53:c1=0x7a3b9e:x0=0:y0=0:x1=1280:y1=720:d=12:speed=0,format=yuv420p',
    '-f', 'lavfi',
    '-i', 'sine=frequency=220:duration=12',
    '-vf', [
      `drawtext=fontfile='${font}':text='videocastle':fontsize=96:fontcolor=white@0.95:x=(w-text_w)/2:y=(h-text_h)/2-60`,
      `drawtext=fontfile='${font}':text='demo clip':fontsize=34:fontcolor=white@0.6:x=(w-text_w)/2:y=(h-text_h)/2+50`,
      `drawtext=fontfile='${font}':timecode='00\\:00\\:00\\:00':r=25:fontsize=40:fontcolor=white@0.85:x=(w-text_w)/2:y=h-140`,
    ].join(','),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    '-t', '12',
    dest,
  ]);
}

async function waitForServer(
  origin: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/api/setup`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(300);
  }
  throw new Error(`Server did not come up on ${origin} within ${timeoutMs}ms`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Converts the recording to a GIF, trimming from the front (the Processing wait
 * is the dullest stretch) until it fits the byte budget. Two passes per attempt:
 * a palette generated from the actual frames, then applied — a shared palette
 * is what keeps a UI screencast from banding into mush.
 */
async function toGif(webm: string, workdir: string): Promise<number> {
  const palette = path.join(workdir, 'palette.png');
  // Each attempt is [width, fps, colors, seconds to skip].
  const attempts: Array<[number, number, number, number]> = [
    [900, 12, 192, 0],
    [900, 12, 128, 0],
    [820, 11, 128, 2],
    [760, 10, 96, 4],
  ];

  for (const [width, fps, colors, skip] of attempts) {
    const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
    const seek = skip > 0 ? ['-ss', String(skip)] : [];
    run(ffmpeg, [
      '-y', ...seek, '-i', webm,
      '-vf', `${filters},palettegen=max_colors=${colors}:stats_mode=diff`,
      palette,
    ]);
    run(ffmpeg, [
      '-y', ...seek, '-i', webm, '-i', palette,
      '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      '-loop', '0',
      OUT,
    ]);
    const { size } = await stat(OUT);
    console.log(
      `  ${width}px ${fps}fps ${colors} colors, skip ${skip}s → ${(size / 1024 / 1024).toFixed(2)} MB`,
    );
    if (size <= MAX_BYTES) return size;
  }
  const { size } = await stat(OUT);
  console.warn(
    `! GIF is ${(size / 1024 / 1024).toFixed(2)} MB, over the ${MAX_BYTES / 1024 / 1024} MB budget.`,
  );
  return size;
}

async function record(
  workdir: string,
  clip: string,
  origin: string,
): Promise<string> {
  const videoDir = path.join(workdir, 'recording');
  const executablePath = resolveBrowser();
  console.log(`· browser: ${executablePath ?? 'playwright bundled chromium'}`);

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      executablePath,
      args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
      // The GIF shows a real local instance; the Share Link on screen reads
      // localhost, which is the honest thing for a self-hosted tool to show.
      baseURL: origin,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();

    // --- First-run setup: one Operator, chosen by whoever runs the server.
    await page.goto('/');
    await page.getByRole('heading', { name: 'Set up your instance' }).waitFor();
    await sleep(900);
    await page.getByLabel('Username').fill(OPERATOR.username);
    await sleep(400);
    await page.getByLabel('Password').fill(OPERATOR.password);
    await sleep(500);
    await page.getByRole('button', { name: 'Create Operator' }).click();

    // --- The Library, empty.
    await page.getByRole('heading', { name: 'Library' }).waitFor();
    await sleep(900);

    // --- Upload.
    await page.getByRole('button', { name: 'Upload' }).click();
    await page.getByRole('heading', { name: 'Upload a video' }).waitFor();
    await sleep(700);
    await page.locator('input[type=file]').setInputFiles(clip);
    await sleep(600);
    await page.getByPlaceholder('Video title').fill('Demo clip');
    await sleep(700);
    await page.getByRole('button', { name: 'Start upload' }).click();

    // --- Processing → Ready, polled live by the Dashboard itself.
    await page.getByText('Processing', { exact: false }).first().waitFor();
    await sleep(1000);
    await page
      .getByText('Ready', { exact: false })
      .first()
      .waitFor({ timeout: 120_000 });
    await sleep(1200);

    // --- Open the Video and copy its Share Link.
    await page.getByText('Demo clip').first().click();
    // `exact` matters: the sidebar has a "Share links" nav item too.
    await page.getByText('Share link', { exact: true }).waitFor();
    await sleep(1000);
    const shareUrl = await page
      .locator('input[readonly]')
      .first()
      .inputValue();
    await page.getByRole('button', { name: 'Copy' }).first().click();
    await sleep(1200);

    // --- The Viewer's side: a link, no account, it plays.
    //
    // Deliberately the *same* page rather than a second tab: Playwright records
    // one video per page, so a new tab would put the payoff of the whole arc in
    // a separate file. One page is one continuous take.
    await page.goto(shareUrl);
    await page.locator('video').waitFor();
    await sleep(900);
    await page.locator('video').evaluate((el: HTMLVideoElement) => {
      void el.play();
    });
    await sleep(4500);

    await page.close();
    await context.close();

    const recording = await page.video()?.path();
    if (!recording) throw new Error('Playwright produced no recording');
    return recording;
  } finally {
    await browser?.close();
  }
}

async function main(): Promise<void> {
  if (!existsSync('web/dist/index.html')) {
    console.log('· building the SPA (web/dist is missing)');
    run('npm', ['run', 'build']);
  }

  const workdir = await mkdtemp(path.join(tmpdir(), 'videocastle-demo-'));
  const dataDir = path.join(workdir, 'data');
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.dirname(OUT), { recursive: true });

  console.log('· generating the clip to upload');
  const clip = path.join(workdir, 'demo-clip.mp4');
  generateClip(clip);

  const port = await pickPort();
  const origin = `http://localhost:${port}`;
  if (port !== 8080) {
    console.log(
      `! 8080 is taken, using ${port} — the Share Link in the GIF will read localhost:${port}`,
    );
  }

  console.log(`· starting a throwaway instance on ${origin}`);
  let server: ChildProcess | undefined;
  try {
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        PORT: String(port),
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForServer(origin);

    console.log('· recording the flow');
    const webm = await record(workdir, clip, origin);

    console.log('· converting to GIF');
    const size = await toGif(webm, workdir);
    console.log(
      `\n✓ ${path.relative(process.cwd(), OUT)} — ${(size / 1024 / 1024).toFixed(2)} MB`,
    );
  } finally {
    server?.kill('SIGTERM');
    await rm(workdir, { recursive: true, force: true });
  }
}

await main();
