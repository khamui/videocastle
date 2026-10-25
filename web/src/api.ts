/** Thin client for the Operator auth API. All calls share the session cookie. */

export interface OperatorSummary {
  username: string;
  createdAt: number;
}

/**
 * An operator-facing API failure that keeps the server's diagnostic structured
 * (ADR-0007): `reason` is the stable machine code (the body's `error`), `detail`
 * the raw technical diagnostic (ffmpeg stderr, paths, …). `message` stays the
 * flat "label: diagnostic" string earlier callers relied on, so this is a
 * non-breaking enrichment — the Dashboard's error surface reads the fields, but
 * anything reading `.message` sees exactly what it did before.
 */
export class ApiError extends Error {
  readonly status: number;
  /** Stable machine `reason` code (server `error`), when the body carried one. */
  readonly reason?: string;
  /** Raw technical diagnostic (server `detail`), verbatim, when present. */
  readonly detail?: string;

  constructor(
    label: string,
    opts: { status: number; reason?: string; detail?: string },
  ) {
    const diagnostic = opts.detail ?? opts.reason;
    super(diagnostic ? `${label}: ${diagnostic}` : label);
    this.name = 'ApiError';
    this.status = opts.status;
    this.reason = opts.reason;
    this.detail = opts.detail;
  }
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
    return new ApiError(label, {
      status: res.status,
      reason: body.error,
      detail: body.detail,
    });
  } catch {
    return new ApiError(label, { status: res.status });
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
  /** Whether a per-Video password gates the Share Link. */
  protected: boolean;
  /** Share Link expiry (epoch ms), or null when it never expires. */
  expiresAt: number | null;
  /** Whether the link has expired as of now (server-evaluated). */
  expired: boolean;
  /** The owning Folder's slug, or null when the Video sits in the Library root. */
  folderSlug: string | null;
  shareUrl: string;
  createdAt: number;
  /** What this Video occupies on disk, as recorded at write time. */
  storage: StorageBytes;
}

/**
 * A byte breakdown, for one Video or for the whole instance. The Source is the
 * part an Operator can choose to give up (ADR-0010); the Rendition is the part
 * that has to stay for the Video to play.
 */
export interface StorageBytes {
  sourceBytes: number;
  renditionBytes: number;
  posterBytes: number;
  totalBytes: number;
}

/** A Folder as the Library sees it. Mirrors the server's FolderView. */
export interface FolderSummary {
  slug: string;
  name: string;
  videoCount: number;
  /** Whether a password gates the `/f/` gallery. */
  protected: boolean;
  /** Gallery link expiry (epoch ms), or null when it never expires. */
  expiresAt: number | null;
  /** Whether the gallery link has expired as of now (server-evaluated). */
  expired: boolean;
  shareUrl: string;
  createdAt: number;
}

export interface TranscodingStatus {
  available: boolean;
  version: string | null;
  /** The technical reason it's unavailable (ADR-0007), when it isn't. */
  error: string | null;
}

/** What `GET /api/status` reports about the server. Operator-only. */
export interface ServerStatus {
  transcoding: TranscodingStatus;
  /** What this instance holds, summed from the per-Video recorded figures. */
  storage: StorageBytes;
}

/** Whether transcoding (ffmpeg) is usable, for the Dashboard's availability banner. */
export async function getStatus(): Promise<TranscodingStatus> {
  const res = await fetch('/api/status', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not load status');
  const data = (await res.json()) as ServerStatus;
  return data.transcoding;
}

/** The Operator's Library, newest first. */
export async function listVideos(): Promise<VideoSummary[]> {
  const res = await fetch('/api/videos', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not load the Library');
  const data = (await res.json()) as { videos: VideoSummary[] };
  return data.videos;
}

/** The Operator's Folders, newest first, each with its Video count. */
export async function listFolders(): Promise<FolderSummary[]> {
  const res = await fetch('/api/folders', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not load Folders');
  const data = (await res.json()) as { folders: FolderSummary[] };
  return data.folders;
}

/** Creates a Folder with the given name and returns it (with a `/f/<slug>` link). */
export async function createFolder(name: string): Promise<FolderSummary> {
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw await operatorError(res, 'Could not create Folder');
  const data = (await res.json()) as { folder: FolderSummary };
  return data.folder;
}

/**
 * Deletes a Folder. `mode` chooses what happens to its Videos (ADR-0006):
 * `'delete'` purges the Folder and every Video in it (media + Share Links);
 * `'keep'` removes the Folder only and moves its Videos to the Library root,
 * leaving each Video's own `/v/<slug>` link intact.
 */
export async function deleteFolder(
  slug: string,
  mode: 'delete' | 'keep',
): Promise<void> {
  const res = await fetch(
    `/api/folders/${encodeURIComponent(slug)}?videos=${mode}`,
    { method: 'DELETE', credentials: 'same-origin' },
  );
  if (!res.ok) throw await operatorError(res, 'Could not delete Folder');
}

/** Protects a Folder's gallery with a password (stored hashed server-side). */
export async function setFolderPassword(
  slug: string,
  password: string,
): Promise<FolderSummary> {
  const res = await fetch(`/api/folders/${encodeURIComponent(slug)}/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw await operatorError(res, 'Could not set Folder password');
  const data = (await res.json()) as { folder: FolderSummary };
  return data.folder;
}

/** Clears a Folder's password, making its gallery open again. */
export async function clearFolderPassword(slug: string): Promise<FolderSummary> {
  const res = await fetch(`/api/folders/${encodeURIComponent(slug)}/password`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await operatorError(res, 'Could not clear Folder password');
  const data = (await res.json()) as { folder: FolderSummary };
  return data.folder;
}

/**
 * Sets, extends, clears, or re-enables a Folder gallery's expiry. Pass epoch
 * milliseconds to expire at that instant, or null to never expire.
 */
export async function setFolderExpiry(
  slug: string,
  expiresAt: number | null,
): Promise<FolderSummary> {
  const res = await fetch(`/api/folders/${encodeURIComponent(slug)}/expiry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ expiresAt }),
  });
  if (!res.ok) throw await operatorError(res, 'Could not update Folder expiry');
  const data = (await res.json()) as { folder: FolderSummary };
  return data.folder;
}

/** Browses a Folder: the Folder and the Videos it holds. */
export async function browseFolder(
  slug: string,
): Promise<{ folder: FolderSummary; videos: VideoSummary[] }> {
  const res = await fetch(`/api/folders/${encodeURIComponent(slug)}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) throw await operatorError(res, 'Could not open Folder');
  return (await res.json()) as { folder: FolderSummary; videos: VideoSummary[] };
}

/**
 * Moves a Video into a Folder (by slug) or back to the Library root (null).
 * A Video belongs to at most one Folder, so this replaces any prior membership.
 */
export async function moveVideoToFolder(
  slug: string,
  folderSlug: string | null,
): Promise<VideoSummary> {
  const res = await fetch(`/api/videos/${encodeURIComponent(slug)}/folder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ folderSlug }),
  });
  if (!res.ok) throw await operatorError(res, 'Could not move Video');
  const data = (await res.json()) as { video: VideoSummary };
  return data.video;
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
  | { state: 'failed' }
  /** The link is password-protected and not yet unlocked — the Viewer is prompted. */
  | { state: 'protected' };

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
 * A Folder as a Viewer sees it through its `/f/<slug>` link. A protected Folder
 * not yet unlocked reveals nothing but that it needs a password; once open it
 * carries its name and playable Videos as tiles. A protected Video keeps its
 * poster sealed (posterUrl null) in the gallery until it's opened (its access
 * then cascades from the Folder). A link that does not resolve (unknown/expired)
 * is a null result — the generic "not available" the server hides behind one 404
 * (ADR-0002, no existence leak).
 */
export type FolderView =
  | { protected: true }
  | { protected: false; slug: string; name: string; videos: GalleryTile[] };

export interface GalleryTile {
  slug: string;
  title: string;
  durationSeconds: number | null;
  protected: boolean;
  posterUrl: string | null;
}

/** Loads a Folder's gallery view, or null when the `/f/<slug>` link doesn't resolve. */
export async function getFolder(slug: string): Promise<FolderView | null> {
  const res = await fetch(`/api/watch/folder/${encodeURIComponent(slug)}`, {
    credentials: 'same-origin',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Could not load this folder');
  const data = (await res.json()) as { folder: FolderView };
  return data.folder;
}

/**
 * Unlocks a protected Folder with the Viewer's password. On success the server
 * sets a Folder-scoped grant cookie (which then cascades to the Folder's Videos)
 * and returns the now-open gallery; returns null for a wrong password or a link
 * that doesn't resolve (a flat, opaque rejection — ADR-0002). The returned view
 * is always the open variant on success.
 */
export async function unlockFolder(
  slug: string,
  password: string,
): Promise<Extract<FolderView, { protected: false }> | null> {
  const res = await fetch(`/api/watch/folder/${encodeURIComponent(slug)}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  });
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) throw new Error('Could not unlock this folder');
  const data = (await res.json()) as { folder: Extract<FolderView, { protected: false }> };
  return data.folder;
}

/**
 * Loads the watch view for a Video opened from within its Folder
 * (`/f/<slug>/<vslug>`). Same shape as {@link getWatch}; a null result means the
 * Video isn't in this Folder (or the Folder/Video doesn't resolve) — the one
 * generic 404. Playback, poster, and unlock then run through the Video's own
 * `/api/watch/:vslug/*` routes exactly as a standalone link does.
 */
export async function getFolderVideo(
  folderSlug: string,
  videoSlug: string,
): Promise<WatchView | null> {
  const res = await fetch(
    `/api/watch/folder/${encodeURIComponent(folderSlug)}/${encodeURIComponent(videoSlug)}`,
    { credentials: 'same-origin' },
  );
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
 * Sets a per-Video password (stored hashed server-side). Returns the updated
 * Video, whose `protected` flag is now true. Surfaces the server's technical
 * reason on failure (ADR-0007).
 */
export async function setVideoPassword(
  slug: string,
  password: string,
): Promise<VideoSummary> {
  const res = await fetch(`/api/videos/${encodeURIComponent(slug)}/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw await operatorError(res, 'Could not set password');
  const data = (await res.json()) as { video: VideoSummary };
  return data.video;
}

/**
 * Sets, extends, clears, or re-enables a Video's Share Link expiry. Pass epoch
 * milliseconds to expire at that instant, or null to never expire. Returns the
 * updated Video (with a server-evaluated `expired` flag).
 */
export async function setVideoExpiry(
  slug: string,
  expiresAt: number | null,
): Promise<VideoSummary> {
  const res = await fetch(`/api/videos/${encodeURIComponent(slug)}/expiry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ expiresAt }),
  });
  if (!res.ok) throw await operatorError(res, 'Could not update expiry');
  const data = (await res.json()) as { video: VideoSummary };
  return data.video;
}

/** Clears a Video's password, making its Share Link open again. */
export async function clearVideoPassword(slug: string): Promise<VideoSummary> {
  const res = await fetch(`/api/videos/${encodeURIComponent(slug)}/password`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await operatorError(res, 'Could not clear password');
  const data = (await res.json()) as { video: VideoSummary };
  return data.video;
}

/**
 * Unlocks a protected Video with the Viewer's password. On success the server
 * sets a slug-scoped grant cookie and returns the now-visible watch view;
 * returns null for a wrong password (a flat, opaque rejection — ADR-0002).
 * Throws only on an unexpected transport error.
 */
export async function unlockWatch(
  slug: string,
  password: string,
): Promise<WatchView | null> {
  const res = await fetch(`/api/watch/${encodeURIComponent(slug)}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  });
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) throw new Error('Could not unlock this video');
  const data = (await res.json()) as { watch: WatchView };
  return data.watch;
}

/**
 * Deletes a Video: purges its Source and Rendition on the server and kills its
 * Share Link at once (the slug stops resolving, so the link collapses into the
 * generic Viewer 404). Irreversible — the Dashboard confirms before calling.
 * Surfaces the server's technical reason on failure (ADR-0007).
 */
export async function deleteVideo(slug: string): Promise<void> {
  const res = await fetch(`/api/videos/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await operatorError(res, 'Delete failed');
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
