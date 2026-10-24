/** Thin client for the Operator auth API. All calls share the session cookie. */

export interface OperatorSummary {
  username: string;
  createdAt: number;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
}

/**
 * Turns an operator-facing API error response into an Error, surfacing the
 * server's technical `detail` (or, failing that, its stable `error` code)
 * rather than a genericised message — the Dashboard is an Operator surface, so
 * it states the real cause (ADR-0007). `label` is the human lead-in; the raw
 * diagnostic is appended when the body carries one.
 */
async function operatorError(res: Response, label: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string };
    const diagnostic = body.detail ?? body.error;
    return new Error(diagnostic ? `${label}: ${diagnostic}` : label);
  } catch {
    return new Error(label);
  }
}

export async function getNeedsSetup(): Promise<boolean> {
  const res = await fetch('/api/setup', { credentials: 'same-origin' });
  const data = (await res.json()) as { needsSetup: boolean };
  return data.needsSetup;
}

/** Returns the signed-in Operator, or null when there is no valid session. */
export async function getMe(): Promise<OperatorSummary | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (res.status === 401) return null;
  const data = (await res.json()) as { operator: OperatorSummary };
  return data.operator;
}

export async function setup(
  username: string,
  password: string,
): Promise<OperatorSummary> {
  const res = await postJson('/api/setup', { username, password });
  if (!res.ok) throw new Error('Setup failed');
  const data = (await res.json()) as { operator: OperatorSummary };
  return data.operator;
}

export async function signIn(
  username: string,
  password: string,
): Promise<OperatorSummary> {
  const res = await postJson('/api/session', { username, password });
  if (res.status === 401) throw new Error('Incorrect username or password');
  if (!res.ok) throw new Error('Sign-in failed');
  const data = (await res.json()) as { operator: OperatorSummary };
  return data.operator;
}

export async function signOut(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' });
}

/** A Video as the Library sees it. Mirrors the server's VideoView. */
export interface VideoSummary {
  slug: string;
  title: string;
  description: string | null;
  state: 'processing' | 'ready' | 'failed';
  progress: number;
  durationSeconds: number | null;
  failureReason: string | null;
  failureDetail: string | null;
  shareUrl: string;
  createdAt: number;
}

export interface TranscodingStatus {
  available: boolean;
  version: string | null;
  /** The technical reason it's unavailable (ADR-0007), when it isn't. */
  error: string | null;
}

/** Whether transcoding (ffmpeg) is usable, for the Dashboard's availability banner. */
export async function getStatus(): Promise<TranscodingStatus> {
  const res = await fetch('/api/status', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not load status');
  const data = (await res.json()) as { transcoding: TranscodingStatus };
  return data.transcoding;
}

/** The Operator's Library, newest first. */
export async function listVideos(): Promise<VideoSummary[]> {
  const res = await fetch('/api/videos', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not load the Library');
  const data = (await res.json()) as { videos: VideoSummary[] };
  return data.videos;
}

/**
 * A Video as a Viewer sees it through its Share Link. Mirrors the server's
 * WatchView: a Ready Video carries its playback URLs; a Processing one carries
 * only what the "being prepared" screen needs; a Failed one is neutral, with no
 * diagnostics (GLOSSARY: Failed → "temporarily unavailable"). A link that does
 * not resolve at all (unknown/deleted) is instead a null result — the generic
 * "not available" case the server hides behind one 404.
 */
export type WatchView =
  | {
      state: 'ready';
      slug: string;
      title: string;
      description: string | null;
      posterUrl: string;
      playlistUrl: string;
    }
  | {
      state: 'processing';
      slug: string;
      title: string;
      description: string | null;
    }
  | { state: 'failed' };

/**
 * Loads the watch view for a Share Link, or null when the link does not resolve
 * (the server returns one generic 404 for unknown/deleted — no existence leak,
 * so the Watch Page shows the same "not available" for all of them).
 */
export async function getWatch(slug: string): Promise<WatchView | null> {
  const res = await fetch(`/api/watch/${encodeURIComponent(slug)}`, {
    credentials: 'same-origin',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Could not load this video');
  const data = (await res.json()) as { watch: WatchView };
  return data.watch;
}

/**
 * Retries a Failed Video: re-queues transcoding against the retained Source so
 * it goes Failed → Processing. Resolves with the re-queued (Processing) Video.
 * On failure the server's technical reason is surfaced (ADR-0007): a 503 when
 * transcoding (ffmpeg) is unavailable, a 409 when the Video wasn't Failed.
 */
export async function retryVideo(slug: string): Promise<VideoSummary> {
  const res = await fetch(`/api/videos/${encodeURIComponent(slug)}/retry`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await operatorError(res, 'Retry failed');
  const data = (await res.json()) as { video: VideoSummary };
  return data.video;
}

/**
 * Uploads a Video. The title and description fields are appended before the
 * file so the server knows them by the time the file stream arrives. Resolves
 * with the created (Processing) Video.
 */
export async function uploadVideo(input: {
  title: string;
  description: string;
  file: File;
}): Promise<VideoSummary> {
  const form = new FormData();
  form.append('title', input.title);
  if (input.description.trim()) form.append('description', input.description);
  form.append('file', input.file);

  const res = await fetch('/api/videos', {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  if (!res.ok) throw await operatorError(res, 'Upload failed');
  const data = (await res.json()) as { video: VideoSummary };
  return data.video;
}
