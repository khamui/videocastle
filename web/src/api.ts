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
  if (res.status === 503) {
    throw new Error('Transcoding is unavailable (ffmpeg not found on the server).');
  }
  if (!res.ok) throw new Error('Upload failed');
  const data = (await res.json()) as { video: VideoSummary };
  return data.video;
}
