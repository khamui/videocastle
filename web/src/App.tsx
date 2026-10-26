import { useEffect, useState } from 'react';
import { WatchPage } from './WatchPage';
import { GalleryPage } from './GalleryPage';
import { FeedbackProvider } from '@/components/feedback/feedback-provider';
import { useFeedback } from '@/components/feedback/use-feedback';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/format';
import {
  AppShell,
  SectionPlaceholder,
  type Section,
} from '@/components/shell/app-shell';
import { Card } from '@/components/ui/card';
import {
  ExpiredBadge,
  ProtectedBadge,
  StatusPill,
  VideoThumb,
  thumbTint,
} from '@/components/library/video-visuals';
import { VideoDrawer } from '@/components/library/video-drawer';
import { FolderDrawer } from '@/components/library/folder-drawer';
import { UploadDialog } from '@/components/library/upload-dialog';
import { StorageSection } from '@/components/storage/storage-section';
import { ServerSection } from '@/components/settings/server-section';
import { NewFolderDialog } from '@/components/library/new-folder-dialog';
import {
  getMe,
  getNeedsSetup,
  getStatus,
  listFolders,
  listVideos,
  setup,
  signIn,
  signOut,
  uploadVideo,
  UploadAborted,
  type FolderSummary,
  type OperatorSummary,
  type ServerStatus,
  type StorageReport,
  type VideoSummary,
} from './api';

type Screen =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'sign-in' }
  | { kind: 'dashboard'; operator: OperatorSummary };

/**
 * A client-only tile for an upload in flight, shown in the Videos grid before
 * the real (server) card exists. `progress` is a 0..1 fraction; `finishing` is
 * the tail after the browser has sent every byte but the server hasn't yet
 * responded (written the Source + created the row), so the bar shouldn't look
 * stuck at an exact 100%.
 */
interface UploadTile {
  id: string;
  title: string;
  description: string | null;
  /** Destination Folder name, or null for the Library root — shown as a tag. */
  folderName: string | null;
  progress: number;
  phase: 'uploading' | 'finishing';
  abort: () => void;
}

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
        <FeedbackProvider>
          <Dashboard
            operator={screen.operator}
            onSignOut={async () => {
              await signOut();
              setScreen({ kind: 'sign-in' });
            }}
          />
        </FeedbackProvider>
      );
  }
}

function Dashboard(props: {
  operator: OperatorSummary;
  onSignOut: () => Promise<void>;
}) {
  const { notify, reportError } = useFeedback();
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Uploads in flight, shown as optimistic tiles until the real card appears.
  const [uploads, setUploads] = useState<UploadTile[]>([]);
  // Which shell nav section is active. Only `library` is built in v1.
  const [section, setSection] = useState<Section>('library');

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

  // Guard against a refresh/navigation that would abort an in-flight upload —
  // the very thing that silently killed uploads before (a reload cancels the
  // request). Best-effort: iOS Safari largely ignores `beforeunload`.
  useEffect(() => {
    if (uploads.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploads.length]);

  // Start an upload: add an optimistic tile, stream the file with real byte
  // progress, then swap the tile for the real (Processing) card on success —
  // or drop it (and report, unless the Operator cancelled) on failure. Several
  // may run at once; each tile is keyed by its own id.
  function startUpload(input: {
    title: string;
    description: string;
    file: File;
    folderSlug: string | null;
  }): void {
    const id = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const folderName =
      input.folderSlug === null
        ? null
        : (folders.find((f) => f.slug === input.folderSlug)?.name ?? null);
    const handle = uploadVideo({
      ...input,
      onProgress: (fraction) =>
        setUploads((prev) =>
          prev.map((u) =>
            u.id === id
              ? {
                  ...u,
                  progress: fraction,
                  phase: fraction >= 1 ? 'finishing' : 'uploading',
                }
              : u,
          ),
        ),
    });
    setUploads((prev) => [
      ...prev,
      {
        id,
        title: input.title,
        description: input.description.trim() || null,
        folderName,
        progress: 0,
        phase: 'uploading',
        abort: handle.abort,
      },
    ]);
    handle.done.then(
      () => {
        setUploads((prev) => prev.filter((u) => u.id !== id));
        // The real card now appears as Processing; the transcode poll takes over.
        void refresh();
        notify('Upload complete · transcoding');
      },
      (err) => {
        setUploads((prev) => prev.filter((u) => u.id !== id));
        if (err instanceof UploadAborted) return; // operator cancelled — not an error
        reportError(err, { title: 'Upload failed' });
      },
    );
  }

  // The Library root lists Folders and the unfiled Videos side by side; a
  // Folder's own Videos live in its drawer, not in this grid.
  const unfiled = (videos ?? []).filter((v) => v.folderSlug === null);

  const storage = status?.storage ?? null;

  const libraryBody = (
    <div className="library">
      <header className="library-head">
        <div className="flex flex-col gap-1">
          <h1>Library</h1>
          <span className="text-sm text-muted-foreground">
            {folders.length} folders · {(videos ?? []).length} videos
          </span>
        </div>
        <div className="flex items-center gap-2">
          <NewFolderDialog onCreated={() => void refresh()} />
          <UploadDialog
            disabled={
              (status != null && !status.transcoding.available) ||
              storage?.pressure === 'full'
            }
            folders={folders}
            onStart={startUpload}
          />
        </div>
      </header>

      {status && !status.transcoding.available && (
        <div className="banner">
          <strong>Transcoding is unavailable.</strong> ffmpeg isn’t runnable on
          the server, so uploads are paused. Install ffmpeg (or set
          <code>FFMPEG_PATH</code>) and it resumes automatically — no restart
          needed.
          {status.transcoding.error && (
            <pre className="banner-detail">{status.transcoding.error}</pre>
          )}
        </div>
      )}

      {/* Approaching or at a storage ceiling is a standing condition, not an
          event, so it gets the banner rather than a toast (ADR-0009). */}
      {storage && storage.pressure !== 'ok' && (
        <StoragePressureBanner storage={storage} />
      )}

      {error && <p className="error">{error}</p>}

      {/* Folders live in the Library root alongside the unfiled Videos. */}
      <h2 className="mb-3 mt-2 text-base font-semibold">Folders</h2>
      {folders.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
          No Folders yet.
        </p>
      ) : (
        <ul className="mb-6 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {folders.map((folder) => (
            <FolderCard
              key={folder.slug}
              folder={folder}
              videos={(videos ?? []).filter(
                (v) => v.folderSlug === folder.slug,
              )}
              folders={folders}
              onChanged={() => void refresh()}
            />
          ))}
        </ul>
      )}

      <h2 className="mb-3 mt-2 text-base font-semibold">Videos</h2>

      {videos === null ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : unfiled.length === 0 && uploads.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
          No unfiled Videos. Upload one to get a Share Link.
        </p>
      ) : (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3">
          {/* Uploads in flight lead the grid; each swaps for its real card on
              completion (or disappears on cancel/failure). */}
          {uploads.map((upload) => (
            <UploadCard
              key={upload.id}
              upload={upload}
              onCancel={upload.abort}
            />
          ))}
          {unfiled.map((video) => (
            <VideoCard
              key={video.slug}
              video={video}
              folders={folders}
              onChanged={() => void refresh()}
            />
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <AppShell
      operator={props.operator.username}
      section={section}
      storage={storage}
      onNavigate={setSection}
      onSignOut={() => void props.onSignOut()}
    >
      {section === 'library' && libraryBody}
      {section === 'storage' && (
        <StorageSection storage={storage} videos={videos} />
      )}
      {section === 'settings' && <ServerSection />}
      {section === 'share-links' && <SectionPlaceholder title="Share links" />}
    </AppShell>
  );
}

/**
 * Standing notice that storage is running out, reusing the ffmpeg-unavailable
 * banner. Deliberately not a toast: a toast is for a transient success
 * (ADR-0009), while approaching a ceiling is a condition the Operator should
 * keep seeing until they act on it. Technical and specific about what to do
 * (ADR-0007) — and explicit that nothing will be deleted for them (ADR-0011).
 */
function StoragePressureBanner(props: { storage: StorageReport }) {
  const { storage } = props;
  const full = storage.pressure === 'full';

  return (
    <div className="banner">
      {full ? (
        <>
          <strong>Storage is full, so uploads are being refused.</strong>{' '}
          {storage.quotaBytes === null
            ? `Free disk on the host has dropped to the ${formatBytes(storage.minFreeDiskBytes)} floor.`
            : `This instance holds ${formatBytes(storage.totalBytes)} against a ${formatBytes(storage.quotaBytes)} quota — ${storage.usedPercent}% of it.`}{' '}
          Delete Videos you no longer need, or raise the ceiling. Nothing will be
          deleted automatically, and Videos you have already shared keep playing.
        </>
      ) : (
        <>
          <strong>Storage is {storage.usedPercent}% full.</strong>{' '}
          {formatBytes(storage.totalBytes)} of{' '}
          {formatBytes(storage.quotaBytes ?? 0)} used
          {storage.writableBytes !== null &&
            `, ${formatBytes(storage.writableBytes)} still writable`}
          . Uploads will be refused once it runs out.
        </>
      )}
      <pre className="banner-detail">
        quota: {storage.quotaBytes === null ? 'unlimited' : `${storage.quotaBytes} bytes (STORAGE_QUOTA_BYTES)`}
        {'\n'}held: {storage.totalBytes} bytes
        {'\n'}free on disk:{' '}
        {storage.freeDiskBytes === null ? 'unknown' : `${storage.freeDiskBytes} bytes`}
        {'\n'}reserved floor: {storage.minFreeDiskBytes} bytes (MIN_FREE_DISK_BYTES)
      </pre>
    </div>
  );
}

function FolderCard(props: {
  folder: FolderSummary;
  /** The Videos in this Folder, listed inside its drawer. */
  videos: VideoSummary[];
  folders: FolderSummary[];
  onChanged: () => void;
}) {
  const { folder } = props;
  const [open, setOpen] = useState(false);

  return (
    <li>
      <Card className="flex flex-col gap-3 p-4">
        <button
          type="button"
          className="flex w-full flex-col items-start gap-1 bg-transparent p-0 text-left text-foreground"
          onClick={() => setOpen(true)}
        >
          <span className="flex items-center gap-2">
            <strong className="text-sm">📁 {folder.name}</strong>
            {folder.protected && <ProtectedBadge label="Password-protected" />}
            {folder.expired && (
              <ExpiredBadge label="The gallery link has expired" />
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {folder.videoCount} video{folder.videoCount === 1 ? '' : 's'}
          </span>
        </button>
        {folder.expiresAt != null && !folder.expired && (
          <p className="text-xs text-muted-foreground">
            Link expires {new Date(folder.expiresAt).toLocaleString()}
          </p>
        )}
      </Card>
      <FolderDrawer
        folder={folder}
        videos={props.videos}
        folders={props.folders}
        onChanged={props.onChanged}
        open={open}
        onOpenChange={setOpen}
      />
    </li>
  );
}

/**
 * An upload in flight, shaped like a {@link VideoCard} so it slots into the same
 * grid, but with the brand-tinted "uploading" treatment (distinct from the amber
 * transcoding bar), a live byte-progress bar, and a real Cancel. It isn't
 * clickable — there's no Video to open yet. Once the upload completes it's
 * replaced by the real card; Cancel aborts the request and drops the tile.
 */
function UploadCard(props: { upload: UploadTile; onCancel: () => void }) {
  const { upload } = props;
  const finishing = upload.phase === 'finishing';
  const pct = Math.round(upload.progress * 100);

  return (
    <li>
      <Card className="overflow-hidden">
        <div className="flex w-full flex-col text-left">
          <VideoThumb state="uploading" tintIndex={0} duration={null} />
          <div className="flex flex-col gap-2 p-3.5">
            <div className="flex items-center gap-2">
              <strong className="min-w-0 flex-1 truncate text-sm">
                {upload.title}
              </strong>
              <StatusPill state="uploading" />
            </div>
            {upload.folderName && (
              <p className="text-xs text-muted-foreground">
                → {upload.folderName}
              </p>
            )}
            {upload.description && (
              <p className="text-xs text-muted-foreground">
                {upload.description}
              </p>
            )}
            <div className="h-1 overflow-hidden rounded bg-background">
              <div
                className={cn(
                  'h-full bg-primary transition-all duration-300',
                  finishing && 'animate-pulse',
                )}
                style={{ width: `${finishing ? 100 : pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs tabular-nums text-muted-foreground">
                {finishing ? 'Finishing…' : `Uploading… ${pct}%`}
              </span>
              <Button variant="outline" size="sm" onClick={props.onCancel}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </li>
  );
}

function VideoCard(props: {
  video: VideoSummary;
  folders: FolderSummary[];
  onChanged: () => void;
}) {
  const { video } = props;
  const [open, setOpen] = useState(false);

  return (
    <li>
      <Card className="overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full flex-col bg-transparent p-0 text-left text-foreground transition-colors hover:bg-accent/20"
        >
          <VideoThumb
            state={video.state}
            tintIndex={thumbTint(video.slug)}
            duration={
              video.durationSeconds != null
                ? formatDuration(video.durationSeconds)
                : null
            }
          />
          <div className="flex flex-col gap-2 p-3.5">
            <div className="flex items-center gap-2">
              <strong className="min-w-0 flex-1 truncate text-sm">
                {video.title}
              </strong>
              {video.protected && <ProtectedBadge label="Password-protected" />}
              {video.expired && (
                <ExpiredBadge label="The Share Link has expired" />
              )}
              <StatusPill state={video.state} />
            </div>
            {video.expiresAt != null && !video.expired && (
              <p className="text-xs text-muted-foreground">
                Link expires {new Date(video.expiresAt).toLocaleString()}
              </p>
            )}
            {video.description && (
              <p className="text-xs text-muted-foreground">
                {video.description}
              </p>
            )}
            {video.state === 'processing' && (
              <div className="h-1 overflow-hidden rounded bg-background">
                <div
                  className="h-full bg-warn transition-all duration-300"
                  style={{ width: `${video.progress}%` }}
                />
              </div>
            )}
            {video.state === 'failed' && (
              <p
                className="text-xs text-destructive"
                title={video.failureDetail ?? undefined}
              >
                {failureText(video.failureReason)}
              </p>
            )}
          </div>
        </button>
      </Card>
      <VideoDrawer
        video={video}
        folders={props.folders}
        tintIndex={thumbTint(video.slug)}
        onChanged={props.onChanged}
        open={open}
        onOpenChange={setOpen}
      />
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
