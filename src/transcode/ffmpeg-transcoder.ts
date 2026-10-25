import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TranscodeError,
  type Transcoder,
  type TranscodeRequest,
  type TranscodeResult,
  type TranscoderAvailability,
} from '../ports/transcoder';

/**
 * The real {@link Transcoder}: shells out to `ffmpeg`/`ffprobe` to produce the
 * single HLS Rendition and Poster per Video (ADR defaults — H.264/AAC, capped
 * at 1080p, 6-second segments, `libx264 -preset veryfast` CRF 23, AAC 128k;
 * poster grabbed at ~10% of duration). Because it is the one slow, external,
 * nondeterministic collaborator, it sits behind the port and is validated
 * separately and lightly rather than in the behavioural suite.
 *
 * Real-world input matters here: phones (e.g. an iPhone's `.mov`) record 10-bit
 * HEVC in HDR (HLG / Dolby Vision) with extra audio (spatial `apple_apac`) and
 * data streams. So the pipeline:
 *  - maps exactly the first video + first audio, dropping everything else
 *    deterministically (rather than ffmpeg's "best stream" guess);
 *  - always outputs 8-bit `yuv420p` H.264 + stereo AAC (universally playable),
 *    tone-mapping HDR (PQ/HLG) down to SDR Rec.709 first (see {@link buildVideoFilter});
 *  - forces keyframes on segment boundaries so HLS splits cleanly.
 *
 * Failures reject with a typed {@link TranscodeError} carrying a reason code and
 * a trimmed ffmpeg stderr tail, so the Operator sees why rather than just "failed".
 */

const RENDITION_DIR = 'rendition';
const PLAYLIST_NAME = 'index.m3u8';
const POSTER_NAME = 'poster.jpg';
const SEGMENT_SECONDS = 6;
/** Max stderr kept as failure detail, so the DB stays tidy. */
const DETAIL_MAX = 2000;

/** Transfer characteristics that mark a source as HDR (needs tone-mapping). */
const HDR_TRANSFERS = new Set([
  'smpte2084', // PQ (HDR10 / Dolby Vision)
  'arib-std-b67', // HLG (what an iPhone's Dolby Vision 8.4 base layer reports)
]);

export interface FfmpegOptions {
  /** `ffmpeg` binary, overridable for tests/unusual installs. */
  ffmpegPath?: string;
  /** `ffprobe` binary. */
  ffprobePath?: string;
  /**
   * `-threads` to cap each invocation at. Undefined leaves ffmpeg its own
   * choice, which is every core available (see {@link threadArgs}).
   */
  threads?: number;
}

interface SourceInfo {
  durationSeconds: number;
  isHdr: boolean;
}

export function createFfmpegTranscoder(options: FfmpegOptions = {}): Transcoder {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const ffprobe = options.ffprobePath ?? 'ffprobe';
  const threads = options.threads;

  return {
    async checkAvailable(): Promise<TranscoderAvailability> {
      let version: string | undefined;
      for (const bin of [ffmpeg, ffprobe]) {
        try {
          const { stdout } = await run(bin, ['-version']);
          version ??= parseVersion(stdout);
        } catch (err) {
          return {
            available: false,
            version: undefined,
            error:
              err instanceof RunError && err.notFound
                ? `${bin} not found on PATH`
                : messageOf(err),
          };
        }
      }
      return { available: true, version, error: undefined };
    },

    async transcode(request: TranscodeRequest): Promise<TranscodeResult> {
      const renditionDir = join(request.outputDir, RENDITION_DIR);
      await mkdir(renditionDir, { recursive: true });

      const info = await probeSource(ffprobe, request.sourcePath);

      await runFfmpegTranscode(ffmpeg, request, renditionDir, info, threads);
      await grabPoster(ffmpeg, request, info, threads);

      return {
        playlistPath: join(RENDITION_DIR, PLAYLIST_NAME),
        posterPath: POSTER_NAME,
        durationSeconds: Math.round(info.durationSeconds),
      };
    },
  };
}

/** Back-compat alias for the wired-in default instance. */
export const ffmpegTranscoder: Transcoder = createFfmpegTranscoder();

/** True for transfer characteristics that require HDR→SDR tone-mapping. */
export function isHdrTransfer(colorTransfer: string | undefined): boolean {
  return colorTransfer !== undefined && HDR_TRANSFERS.has(colorTransfer);
}

/**
 * Builds the video filtergraph. Both paths cap the frame at 1080p without
 * upscaling, force even dimensions (libx264 / yuv420p requires them), and end
 * at 8-bit `yuv420p`. An HDR source is additionally linearized, tone-mapped
 * (Hable) and brought into Rec.709 so the SDR H.264 looks right.
 */
export function buildVideoFilter(isHdr: boolean): string {
  const cap =
    "scale=w='min(iw,1920)':h='min(ih,1080)':force_original_aspect_ratio=decrease," +
    'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  if (!isHdr) return `${cap},format=yuv420p`;
  return `${cap},${TONEMAP_CHAIN}`;
}

// zscale/tonemap HDR→SDR. Requires an ffmpeg built with libzimg (Debian's
// ffmpeg, bundled in the Docker image, has it).
const TONEMAP_CHAIN =
  'zscale=t=linear:npl=100,' +
  'tonemap=tonemap=hable:desat=0,' +
  'zscale=t=bt709:m=bt709:p=bt709:r=limited,' +
  'format=yuv420p';

async function probeSource(
  ffprobe: string,
  sourcePath: string,
): Promise<SourceInfo> {
  let stdout: string;
  try {
    ({ stdout } = await run(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=color_transfer,width,height:format=duration',
      '-of',
      'json',
      sourcePath,
    ]));
  } catch (err) {
    throw asTranscodeError(err, 'probe_failed');
  }

  let parsed: {
    streams?: Array<{ color_transfer?: string }>;
    format?: { duration?: string };
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new TranscodeError('probe_failed', 'ffprobe returned unreadable output');
  }

  // `-select_streams v:0` yields no streams for an audio-only / video-less file.
  if (!parsed.streams || parsed.streams.length === 0) {
    throw new TranscodeError('no_video_stream', 'the Source has no video stream');
  }

  let durationSeconds = 0;
  const seconds = Number.parseFloat(parsed.format?.duration ?? '');
  if (Number.isFinite(seconds) && seconds > 0) durationSeconds = seconds;

  return { durationSeconds, isHdr: isHdrTransfer(parsed.streams[0]?.color_transfer) };
}

/**
 * `-threads N`, or nothing when the Operator hasn't asked for a cap. ffmpeg's
 * own default is every core, so an uncapped transcode saturates the box however
 * low `TRANSCODE_CONCURRENCY` is set.
 *
 * `-threads` configures the codec context it precedes, so a cap that is meant
 * to bound CPU has to be stated twice: once before the input (the decoder) and
 * once before the output (the encoder). Capping only the encoder still leaves
 * HEVC decoding of a phone clip free to use every core.
 */
function threadArgs(threads: number | undefined): string[] {
  return threads === undefined ? [] : ['-threads', String(threads)];
}

/**
 * The full transcode invocation. Exported so the argument construction — the
 * part that decides playability and CPU use — is assertable without a real
 * ffmpeg on PATH.
 */
export function buildTranscodeArgs(opts: {
  sourcePath: string;
  renditionDir: string;
  isHdr: boolean;
  threads?: number;
}): string[] {
  return [
    '-nostdin',
    '-y',
    // Decoder threads for the input that follows.
    ...threadArgs(opts.threads),
    '-i',
    opts.sourcePath,
    // Take exactly the first video and the first audio (optional, so no-audio
    // Sources still work); drop data/subtitle/extra-audio (e.g. apple_apac).
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    buildVideoFilter(opts.isHdr),
    '-pix_fmt',
    'yuv420p',
    // Encoder threads for the libx264 output that follows.
    ...threadArgs(opts.threads),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    // Force a keyframe on each segment boundary so HLS segments split cleanly.
    '-force_key_frames',
    `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    // Tag the output as SDR Rec.709 (correct after tone-mapping; harmless for
    // already-SDR HD sources).
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    // Downmix to stereo: phone clips can carry more channels than a browser
    // needs, and AAC-stereo is universally playable.
    '-ac',
    '2',
    '-hls_time',
    String(SEGMENT_SECONDS),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    join(opts.renditionDir, 'seg_%03d.ts'),
    '-progress',
    'pipe:1',
    '-nostats',
    join(opts.renditionDir, PLAYLIST_NAME),
  ];
}

/** The poster grab. Exported alongside {@link buildTranscodeArgs}. */
export function buildPosterArgs(opts: {
  sourcePath: string;
  posterPath: string;
  atSeconds: number;
  isHdr: boolean;
  threads?: number;
}): string[] {
  const args = [
    '-nostdin',
    '-y',
    ...threadArgs(opts.threads),
    '-ss',
    opts.atSeconds.toFixed(3),
    '-i',
    opts.sourcePath,
  ];
  // An HDR still must be tone-mapped too, or the poster looks washed out.
  if (opts.isHdr) args.push('-vf', TONEMAP_CHAIN);
  args.push(
    ...threadArgs(opts.threads),
    '-frames:v',
    '1',
    '-q:v',
    '3',
    opts.posterPath,
  );
  return args;
}

async function runFfmpegTranscode(
  ffmpeg: string,
  request: TranscodeRequest,
  renditionDir: string,
  info: SourceInfo,
  threads: number | undefined,
): Promise<void> {
  const args = buildTranscodeArgs({
    sourcePath: request.sourcePath,
    renditionDir,
    isHdr: info.isHdr,
    threads,
  });

  const onStdout =
    info.durationSeconds > 0 && request.onProgress
      ? makeProgressReader(info.durationSeconds, request.onProgress)
      : undefined;

  try {
    await run(ffmpeg, args, onStdout);
  } catch (err) {
    throw asTranscodeError(err, 'encode_failed');
  }
  // Nudge to 100% on success; `markReady` will pin it there regardless.
  await request.onProgress?.(100);
}

async function grabPoster(
  ffmpeg: string,
  request: TranscodeRequest,
  info: SourceInfo,
  threads: number | undefined,
): Promise<void> {
  const args = buildPosterArgs({
    sourcePath: request.sourcePath,
    posterPath: join(request.outputDir, POSTER_NAME),
    atSeconds: info.durationSeconds > 0 ? info.durationSeconds * 0.1 : 0,
    isHdr: info.isHdr,
    threads,
  });
  try {
    await run(ffmpeg, args);
  } catch (err) {
    throw asTranscodeError(err, 'poster_failed');
  }
}

/** Parses the version token from an `ffmpeg -version` first line. */
function parseVersion(stdout: string): string | undefined {
  return /version\s+(\S+)/.exec(stdout)?.[1];
}

/** Maps a low-level run failure to a typed, reason-carrying transcode error. */
function asTranscodeError(
  err: unknown,
  reason: TranscodeError['reason'],
): TranscodeError {
  if (err instanceof RunError) {
    if (err.notFound) {
      return new TranscodeError(
        'ffmpeg_not_found',
        `${err.command} not found on PATH — install ffmpeg to transcode Videos`,
      );
    }
    return new TranscodeError(reason, err.message, tail(err.stderr));
  }
  return new TranscodeError(reason, messageOf(err));
}

function tail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > DETAIL_MAX ? trimmed.slice(-DETAIL_MAX) : trimmed;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parses `ffmpeg -progress pipe:1` output (key=value lines, `out_time_us` in
 * microseconds) into an integer percentage, firing `onProgress` only when the
 * whole-number percent advances so the sink isn't spammed.
 */
function makeProgressReader(
  durationSeconds: number,
  onProgress: (percent: number) => void | Promise<void>,
): (chunk: string) => void {
  let buffer = '';
  let lastPercent = -1;
  return (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      if (line.slice(0, eq) !== 'out_time_us') continue;
      const us = Number.parseInt(line.slice(eq + 1), 10);
      if (!Number.isFinite(us)) continue;
      const percent = Math.max(
        0,
        Math.min(99, Math.floor((us / 1e6 / durationSeconds) * 100)),
      );
      if (percent > lastPercent) {
        lastPercent = percent;
        void onProgress(percent);
      }
    }
  };
}

/** A failed child process: the binary was missing, or it exited nonzero. */
class RunError extends Error {
  readonly command: string;
  readonly notFound: boolean;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(opts: {
    command: string;
    notFound: boolean;
    exitCode: number | null;
    stderr: string;
    message: string;
  }) {
    super(opts.message);
    this.name = 'RunError';
    this.command = opts.command;
    this.notFound = opts.notFound;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
  }
}

/** Spawns a command, resolving with its stdout or rejecting with a RunError. */
function run(
  command: string,
  args: string[],
  onStdout?: (chunk: string) => void,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      const notFound = err.code === 'ENOENT';
      reject(
        new RunError({
          command,
          notFound,
          exitCode: null,
          stderr,
          message: notFound
            ? `${command} not found on PATH`
            : `${command} failed to start: ${err.message}`,
        }),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout });
      } else {
        reject(
          new RunError({
            command,
            notFound: false,
            exitCode: code,
            stderr,
            message: `${command} exited with code ${code}`,
          }),
        );
      }
    });
  });
}
