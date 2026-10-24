import { useEffect, useRef, useState } from 'react';
import { WatchPage } from './WatchPage';
import { GalleryPage } from './GalleryPage';
import {
  clearVideoPassword,
  createFolder,
  deleteVideo,
  getMe,
  getNeedsSetup,
  getStatus,
  listFolders,
  listVideos,
  moveVideoToFolder,
  retryVideo,
  setup,
  setVideoExpiry,
  setVideoPassword,
  signIn,
  signOut,
  uploadVideo,
  type FolderSummary,
  type OperatorSummary,
  type TranscodingStatus,
  type VideoSummary,
} from './api';

type Screen =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'sign-in' }
  | { kind: 'dashboard'; operator: OperatorSummary };

/** `/v/<slug>` is the public Viewer Share Link; everything else is the Dashboard. */
function watchSlug(pathname: string): string | null {
  const match = /^\/v\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * `/f/<slug>` is a Folder shared as a gallery; `/f/<slug>/<vslug>` is a Video
 * opened from within it (the Watch Page then shows a back-to-gallery link).
 */
function folderRoute(
  pathname: string,
): { folderSlug: string; videoSlug: string | null } | null {
  const match = /^\/f\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  return {
    folderSlug: decodeURIComponent(match[1]!),
    videoSlug: match[2] ? decodeURIComponent(match[2]) : null,
  };
}

export function App() {
  // The Viewer surfaces are distinct, account-free pages (ADR-0002): resolve
  // them straight from the URL before the Operator setup/sign-in flow runs.
  const { pathname } = window.location;

  const slug = watchSlug(pathname);
  if (slug) return <WatchPage slug={slug} />;

  const folder = folderRoute(pathname);
  if (folder) {
    return folder.videoSlug
      ? <WatchPage slug={folder.videoSlug} folderSlug={folder.folderSlug} />
      : <GalleryPage slug={folder.folderSlug} />;
  }

  return <OperatorApp />;
}

/** The Operator-facing app: first-run setup, sign-in, then the Library. */
function OperatorApp() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });

  useEffect(() => {
    void (async () => {
      if (await getNeedsSetup()) {
        setScreen({ kind: 'setup' });
        return;
      }
      const me = await getMe();
      setScreen(me ? { kind: 'dashboard', operator: me } : { kind: 'sign-in' });
    })();
  }, []);

  switch (screen.kind) {
    case 'loading':
      return <Centered>Loading…</Centered>;
    case 'setup':
      return (
        <CredentialForm
          title="Set up your instance"
          subtitle="Choose the single Operator credential for this server."
          submitLabel="Create Operator"
          onSubmit={async (u, p) => {
            const operator = await setup(u, p);
            setScreen({ kind: 'dashboard', operator });
          }}
        />
      );
    case 'sign-in':
      return (
        <CredentialForm
          title="Sign in"
          subtitle="Enter your Operator credentials."
          submitLabel="Sign in"
          onSubmit={async (u, p) => {
            const operator = await signIn(u, p);
            setScreen({ kind: 'dashboard', operator });
          }}
        />
      );
    case 'dashboard':
      return (
        <Dashboard
          operator={screen.operator}
          onSignOut={async () => {
            await signOut();
            setScreen({ kind: 'sign-in' });
          }}
        />
      );
  }
}

function Dashboard(props: {
  operator: OperatorSummary;
  onSignOut: () => Promise<void>;
}) {
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [status, setStatus] = useState<TranscodingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which Folder is open, or null for the Library root (Folders + unfiled Videos).
  const [openFolder, setOpenFolder] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [vids, flds, stat] = await Promise.all([
        listVideos(),
        listFolders(),
        getStatus(),
      ]);
      setVideos(vids);
      setFolders(flds);
      setStatus(stat);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the Library');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // While anything is still transcoding, poll so state and progress stay live.
  const anyProcessing = (videos ?? []).some((v) => v.state === 'processing');
  useEffect(() => {
    if (!anyProcessing) return;
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [anyProcessing]);

  async function newFolder(): Promise<void> {
    const name = window.prompt('Name the new Folder:');
    if (name === null || name.trim().length === 0) return;
    setError(null);
    try {
      await createFolder(name.trim());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create Folder');
    }
  }

  // The Videos shown depends on where we are: inside a Folder, only its Videos;
  // at the root, only the unfiled ones (Folders are listed separately).
  const shown = (videos ?? []).filter((v) => v.folderSlug === openFolder);
  const current = folders.find((f) => f.slug === openFolder) ?? null;

  return (
    <main className="library">
      <header className="library-head">
        <h1>{openFolder ? current?.name ?? 'Folder' : 'Library'}</h1>
        <div className="library-head-right">
          <span className="muted">{props.operator.username}</span>
          <button className="ghost" onClick={() => void props.onSignOut()}>
            Sign out
          </button>
        </div>
      </header>

      {openFolder ? (
        <button className="ghost back" onClick={() => setOpenFolder(null)}>
          ← Back to Library
        </button>
      ) : null}

      {status && !status.available && (
        <div className="banner">
          <strong>Transcoding is unavailable.</strong> ffmpeg isn’t runnable on
          the server, so uploads are paused. Install ffmpeg (or set
          <code>FFMPEG_PATH</code>) and it resumes automatically — no restart
          needed.
          {status.error && <pre className="banner-detail">{status.error}</pre>}
        </div>
      )}

      <UploadForm
        disabled={status != null && !status.available}
        onUploaded={() => void refresh()}
      />

      {error && <p className="error">{error}</p>}

      {/* Folders live in the Library root alongside the unfiled Videos. */}
      {!openFolder && (
        <section className="folders-head">
          <h2>Folders</h2>
          <button className="ghost" onClick={() => void newFolder()}>
            New folder
          </button>
        </section>
      )}
      {!openFolder &&
        (folders.length === 0 ? (
          <p className="placeholder">No Folders yet.</p>
        ) : (
          <ul className="folder-grid">
            {folders.map((folder) => (
              <li key={folder.slug}>
                <button
                  className="card folder-card"
                  onClick={() => setOpenFolder(folder.slug)}
                >
                  <strong>📁 {folder.name}</strong>
                  <span className="muted">
                    {folder.videoCount} video{folder.videoCount === 1 ? '' : 's'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      {!openFolder && <h2>Videos</h2>}

      {videos === null ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="placeholder">
          {openFolder
            ? 'This Folder is empty. Move a Video into it from the Library.'
            : 'No unfiled Videos. Upload one above to get a Share Link.'}
        </p>
      ) : (
        <ul className="video-grid">
          {shown.map((video) => (
            <VideoCard
              key={video.slug}
              video={video}
              folders={folders}
              onChanged={() => void refresh()}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function UploadForm(props: { onUploaded: () => void; disabled?: boolean }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <form
      className="upload"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        setError(null);
        setBusy(true);
        try {
          await uploadVideo({ title, description, file });
          setTitle('');
          setDescription('');
          setFile(null);
          if (fileInput.current) fileInput.current.value = '';
          props.onUploaded();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Upload failed');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="upload-row">
        <input
          className="upload-title"
          placeholder="Video title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <input
          ref={fileInput}
          type="file"
          accept="video/*,.mov,.mp4,.m4v"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
        <button
          type="submit"
          disabled={
            props.disabled || busy || !file || title.trim().length === 0
          }
        >
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      <input
        className="upload-desc"
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function VideoCard(props: {
  video: VideoSummary;
  folders: FolderSummary[];
  onChanged: () => void;
}) {
  const { video } = props;
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function retry(): Promise<void> {
    setRetryError(null);
    setRetrying(true);
    try {
      await retryVideo(video.slug);
      props.onChanged();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(false);
    }
  }

  async function togglePassword(): Promise<void> {
    setActionError(null);
    try {
      if (video.protected) {
        if (!window.confirm(`Remove the password on “${video.title}”? Anyone with the link will be able to watch it.`)) {
          return;
        }
        await clearVideoPassword(video.slug);
      } else {
        const password = window.prompt(`Set a password for “${video.title}”. Viewers will be prompted for it before playback.`);
        if (password === null || password.trim().length === 0) return;
        await setVideoPassword(video.slug, password.trim());
      }
      props.onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update password');
    }
  }

  async function editExpiry(): Promise<void> {
    setActionError(null);
    // Minimal control: expiry is entered as whole days from now. Blank clears
    // it (never expires); 0 expires the link immediately. The server stores the
    // absolute instant and evaluates it against its own Clock.
    const current = video.expiresAt
      ? `Currently expires ${new Date(video.expiresAt).toLocaleString()}.\n\n`
      : '';
    const answer = window.prompt(
      `${current}Expire “${video.title}” in how many days from now? ` +
        `Leave blank to clear the expiry; enter 0 to expire now.`,
    );
    if (answer === null) return; // cancelled
    const trimmed = answer.trim();
    let expiresAt: number | null;
    if (trimmed.length === 0) {
      expiresAt = null;
    } else {
      const days = Number(trimmed);
      if (!Number.isFinite(days) || days < 0) {
        setActionError('Enter a number of days (0 or more), or leave blank to clear.');
        return;
      }
      expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
    }
    try {
      await setVideoExpiry(video.slug, expiresAt);
      props.onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update expiry');
    }
  }

  async function move(): Promise<void> {
    setActionError(null);
    // Minimal picker: list the Folders by number; blank moves to the root.
    const menu = props.folders
      .map((f, i) => `${i + 1}. ${f.name}`)
      .join('\n');
    const answer = window.prompt(
      `Move “${video.title}” to which Folder?\n\n${menu || '(no Folders yet)'}\n\n` +
        `Enter a number, or leave blank to move it to the Library root.`,
    );
    if (answer === null) return; // cancelled
    const trimmed = answer.trim();
    let folderSlug: string | null;
    if (trimmed.length === 0) {
      folderSlug = null;
    } else {
      const index = Number(trimmed);
      const target = props.folders[index - 1];
      if (!Number.isInteger(index) || !target) {
        setActionError('Enter one of the listed Folder numbers, or leave blank for the root.');
        return;
      }
      folderSlug = target.slug;
    }
    try {
      await moveVideoToFolder(video.slug, folderSlug);
      props.onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not move Video');
    }
  }

  async function remove(): Promise<void> {
    // Deletion is irreversible — purges the Source and Rendition and kills the
    // Share Link (spec: story 20). Confirm before it happens so it can't be an
    // accident; the window.confirm is the only gate, deliberately.
    const confirmed = window.confirm(
      `Delete “${video.title}”? This permanently removes the video and its ` +
        `Share Link stops working immediately. This can’t be undone.`,
    );
    if (!confirmed) return;
    setActionError(null);
    setDeleting(true);
    try {
      await deleteVideo(video.slug);
      props.onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed');
      setDeleting(false);
    }
  }

  async function copyLink(): Promise<void> {
    const url = `${window.location.origin}${video.shareUrl}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <li className="card video-card">
      <div
        className={`thumb ${
          video.state === 'processing'
            ? 'thumb-processing'
            : video.state === 'failed'
              ? 'thumb-failed'
              : `thumb-${hashIndex(video.slug)}`
        }`}
      >
        {video.durationSeconds != null && (
          <span className="duration">{formatDuration(video.durationSeconds)}</span>
        )}
      </div>
      <div className="video-body">
        <div className="video-title-row">
          <strong className="video-title">{video.title}</strong>
          {video.protected && (
            <span className="pill protected" title="Password-protected">
              🔒
            </span>
          )}
          {video.expired && (
            <span className="pill expired" title="The Share Link has expired">
              expired
            </span>
          )}
          <span className={`pill ${video.state}`}>{video.state}</span>
        </div>
        {video.expiresAt != null && !video.expired && (
          <p className="muted expiry-note">
            Link expires {new Date(video.expiresAt).toLocaleString()}
          </p>
        )}
        {video.description && <p className="muted video-desc">{video.description}</p>}
        {video.state === 'processing' && (
          <div className="prog">
            <span style={{ width: `${video.progress}%` }} />
          </div>
        )}
        {video.state === 'failed' && (
          <p className="fail-reason" title={video.failureDetail ?? undefined}>
            {failureText(video.failureReason)}
          </p>
        )}
        <div className="video-actions">
          {video.state === 'failed' ? (
            <button
              className="ghost retry"
              onClick={() => void retry()}
              disabled={retrying}
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          ) : (
            <button className="ghost copy" onClick={() => void copyLink()}>
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          )}
          <button className="ghost password" onClick={() => void togglePassword()}>
            {video.protected ? 'Remove password' : 'Set password'}
          </button>
          <button className="ghost expiry" onClick={() => void editExpiry()}>
            {video.expiresAt != null ? 'Edit expiry' : 'Set expiry'}
          </button>
          <button className="ghost move" onClick={() => void move()}>
            Move
          </button>
          <button
            className="ghost danger delete"
            onClick={() => void remove()}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
        {retryError && <p className="error">{retryError}</p>}
        {actionError && <p className="error">{actionError}</p>}
      </div>
    </li>
  );
}

/** Friendly text for a transcode failure code (hover shows the raw detail). */
function failureText(reason: string | null): string {
  switch (reason) {
    case 'ffmpeg_not_found':
      return 'Transcoding failed: ffmpeg not found on the server.';
    case 'probe_failed':
      return 'Transcoding failed: the file could not be read.';
    case 'no_video_stream':
      return 'Transcoding failed: no video track in this file.';
    case 'poster_failed':
      return 'Transcoding failed while generating the poster.';
    case 'encode_failed':
      return 'Transcoding failed while encoding this video.';
    default:
      return 'Transcoding failed.';
  }
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Stable 0–4 index from a slug, so each placeholder thumbnail gets a steady tint. */
function hashIndex(slug: string): number {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) | 0;
  return Math.abs(hash) % 5;
}

function CredentialForm(props: {
  title: string;
  subtitle: string;
  submitLabel: string;
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Centered>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            await props.onSubmit(username, password);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong');
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>{props.title}</h1>
        <p className="muted">{props.subtitle}</p>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Working…' : props.submitLabel}
        </button>
      </form>
    </Centered>
  );
}

function Centered(props: { children: React.ReactNode }) {
  return <main className="centered">{props.children}</main>;
}
