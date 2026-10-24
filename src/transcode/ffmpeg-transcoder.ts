import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Transcoder,
  TranscodeRequest,
  TranscodeResult,
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
 * HEVC in HDR (HLG / Dolby Vision). Transcoding that straight through would
 * yield a 10-bit / HDR H.264 that browsers can't play and that looks washed
 * out. So the output is always forced to 8-bit `yuv420p`, and HDR sources are
 * tone-mapped down to SDR Rec.709 first (see {@link buildVideoFilter}).
 */

const RENDITION_DIR = 'rendition';
const PLAYLIST_NAME = 'index.m3u8';
const POSTER_NAME = 'poster.jpg';

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
}

interface SourceInfo {
  durationSeconds: number;
  isHdr: boolean;
}

export function createFfmpegTranscoder(options: FfmpegOptions = {}): Transcoder {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const ffprobe = options.ffprobePath ?? 'ffprobe';

  return {
    async transcode(request: TranscodeRequest): Promise<TranscodeResult> {
      const renditionDir = join(request.outputDir, RENDITION_DIR);
      await mkdir(renditionDir, { recursive: true });

      const info = await probeSource(ffprobe, request.sourcePath);

      await runFfmpegTranscode(ffmpeg, request, renditionDir, info);
      await grabPoster(ffmpeg, request, info);

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
  const { stdout } = await run(ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=color_transfer:format=duration',
    '-of',
    'json',
    sourcePath,
  ]);

  let durationSeconds = 0;
  let colorTransfer: string | undefined;
  try {
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ color_transfer?: string }>;
      format?: { duration?: string };
    };
    const seconds = Number.parseFloat(parsed.format?.duration ?? '');
    if (Number.isFinite(seconds) && seconds > 0) durationSeconds = seconds;
    colorTransfer = parsed.streams?.[0]?.color_transfer;
  } catch {
    // Leave defaults; a zero duration just disables progress reporting.
  }

  return { durationSeconds, isHdr: isHdrTransfer(colorTransfer) };
}

function runFfmpegTranscode(
  ffmpeg: string,
  request: TranscodeRequest,
  renditionDir: string,
  info: SourceInfo,
): Promise<void> {
  const args = [
    '-nostdin',
    '-y',
    '-i',
    request.sourcePath,
    '-vf',
    buildVideoFilter(info.isHdr),
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
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
    '6',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    join(renditionDir, 'seg_%03d.ts'),
    '-progress',
    'pipe:1',
    '-nostats',
    join(renditionDir, PLAYLIST_NAME),
  ];

  const onStdout =
    info.durationSeconds > 0 && request.onProgress
      ? makeProgressReader(info.durationSeconds, request.onProgress)
      : undefined;

  return run(ffmpeg, args, onStdout).then(() => {
    // Nudge to 100% on success; `markReady` will pin it there regardless.
    request.onProgress?.(100);
  });
}

function grabPoster(
  ffmpeg: string,
  request: TranscodeRequest,
  info: SourceInfo,
): Promise<void> {
  const at = info.durationSeconds > 0 ? info.durationSeconds * 0.1 : 0;
  const args = ['-nostdin', '-y', '-ss', at.toFixed(3), '-i', request.sourcePath];
  // An HDR still must be tone-mapped too, or the poster looks washed out.
  if (info.isHdr) args.push('-vf', TONEMAP_CHAIN);
  args.push(
    '-frames:v',
    '1',
    '-q:v',
    '3',
    join(request.outputDir, POSTER_NAME),
  );
  return run(ffmpeg, args).then(() => undefined);
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

/** Spawns a command, resolving with its stdout or rejecting on nonzero exit. */
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
      // The most common first-run failure: the binary isn't installed. Say so
      // plainly rather than surfacing a bare ENOENT.
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `${command} not found on PATH — install ffmpeg to transcode Videos`,
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
