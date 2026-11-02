import { useEffect, useRef, useState } from 'react';
import { WatchPage } from './WatchPage';
import { GalleryPage } from './GalleryPage';
import { FeedbackProvider } from '@/components/feedback/feedback-provider';
import { useFeedback } from '@/components/feedback/use-feedback';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/format';
import { AppShell, type Section } from '@/components/shell/app-shell';
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
import { ShareLinksPage } from '@/components/share-links/share-links-page';
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
  uploadVideoResumable,
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
 * A client-only tile for one file in an Upload batch, shown in the Videos grid
 * before the real (server) card exists (GLOSSARY: Upload). Files upload one at
 * a time, so a tile sits `queued` until its turn, then `uploading`, then
 * `finishing` (the tail after every byte is sent but the server hasn't yet
 * created the Video), and `failed` if it errored — from which it can retry.
 * `progress` is a 0..1 fraction; `abort` is set only while the file is active.
 */
interface UploadTile {
  id: string;
  title: string;
  description: string | null;
  /** Destination Folder name, or null for the Library root — shown as a tag. */
  folderName: string | null;
  /** Destination Folder slug, carried so a retry re-files the Video the same way. */
  folderSlug: string | null;
  /** The file itself, kept so a failed tile can retry without re-picking it. */
  file: File;
  progress: number;
  phase: 'queued' | 'uploading' | 'finishing' | 'failed';
  /** The failure message when `phase === 'failed'`, else null. */
  error: string | null;
  /** Aborts the in-flight upload; set only while `phase === 'uploading' | 'finishing'`. */
  abort: (() => void) | null;
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
  // The queue's authoritative copy (so the sequential pump reads the latest
  // without a stale closure) and a guard so exactly one file is in flight.
  const tilesRef = useRef<UploadTile[]>([]);
  const activeRef = useRef(false);
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

  // Write the queue through `tilesRef` so the pump always reads the latest
  // tiles synchronously (React state alone would be a tick behind).
  function commitTiles(next: UploadTile[]): void {
    tilesRef.current = next;
    setUploads(next);
  }
  function patchTile(id: string, patch: Partial<UploadTile>): void {
    commitTiles(tilesRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
  function dropTile(id: string): void {
    commitTiles(tilesRef.current.filter((t) => t.id !== id));
  }

  // Drive the queue one file at a time (ADR-0013: sequential, kinder to a mobile
  // radio and cleanly resumable). Starts the next `queued` tile when nothing is
  // in flight; a file finishing, failing, or being cancelled calls back here to
  // advance — so one file failing never stalls the rest of the batch.
  function pump(): void {
    if (activeRef.current) return;
    const next = tilesRef.current.find((t) => t.phase === 'queued');
    if (!next) return;

    activeRef.current = true;
    const handle = uploadVideoResumable({
      title: next.title,
      description: next.description ?? '',
      file: next.file,
      folderSlug: next.folderSlug,
      onProgress: (fraction) =>
        patchTile(next.id, {
          progress: fraction,
          phase: fraction >= 1 ? 'finishing' : 'uploading',
        }),
    });
    patchTile(next.id, { phase: 'uploading', progress: 0, error: null, abort: handle.abort });

    handle.done.then(
      () => {
        dropTile(next.id); // the real Processing card takes its place on refresh
        activeRef.current = false;
        void refresh();
        notify('Upload complete · transcoding');
        pump();
      },
      (err) => {
        activeRef.current = false;
        if (err instanceof UploadAborted) {
          dropTile(next.id); // operator cancelled — not an error
        } else {
          patchTile(next.id, {
            phase: 'failed',
            abort: null,
            error: err instanceof Error ? err.message : 'Upload failed',
          });
          reportError(err, { title: 'Upload failed' });
        }
        pump(); // carry on with the rest of the batch
      },
    );
  }

  // Queue a whole Upload batch; the pump uploads them one at a time.
  function startBatch(
    items: { title: string; description: string; file: File; folderSlug: string | null }[],
  ): void {
    const tiles: UploadTile[] = items.map((item) => ({
      id: `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: item.title,
      description: item.description.trim() || null,
      folderName:
        item.folderSlug === null
          ? null
          : (folders.find((f) => f.slug === item.folderSlug)?.name ?? null),
      folderSlug: item.folderSlug,
      file: item.file,
      progress: 0,
      phase: 'queued',
      error: null,
      abort: null,
    }));
    commitTiles([...tilesRef.current, ...tiles]);
    pump();
  }

  // Re-queue a failed file; cancel an active (abort), queued, or failed one.
  function retryTile(id: string): void {
    patchTile(id, { phase: 'queued', progress: 0, error: null });
    pump();
  }
  function cancelTile(id: string): void {
    const tile = tilesRef.current.find((t) => t.id === id);
    if (tile?.abort) tile.abort(); // active → aborts, its handler drops the tile
    else dropTile(id); // queued or failed → just remove it
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
            maxBatch={status?.uploads.maxBatch ?? 15}
            onStart={startBatch}
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
              onCancel={() => cancelTile(upload.id)}
              onRetry={() => retryTile(upload.id)}
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
      {section === 'share-links' && (
        <ShareLinksPage onChanged={() => void refresh()} />
      )}
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
 * One file in an Upload batch, shaped like a {@link VideoCard} so it slots into
 * the same grid, with the brand-tinted "uploading" treatment (distinct from the
 * amber transcoding bar). It isn't clickable — there's no Video to open yet. A
 * tile is `queued` until its turn, shows live byte progress while `uploading`,
 * and on `failed` offers Retry. Cancel aborts the request (terminating the
 * server-side partial) and drops the tile; on completion the real Processing
 * card takes its place.
 */
function UploadCard(props: { upload: UploadTile; onCancel: () => void; onRetry: () => void }) {
  const { upload } = props;
  const finishing = upload.phase === 'finishing';
  const failed = upload.phase === 'failed';
  const queued = upload.phase === 'queued';
  const pct = Math.round(upload.progress * 100);
  // A blank title is shown as the muted "Unnamed video" the server will store.
  const titled = upload.title.trim().length > 0;

  const label = failed
    ? 'Upload failed'
    : queued
      ? 'Queued'
      : finishing
        ? 'Finishing…'
        : `Uploading… ${pct}%`;

  return (
    <li>
      <Card className="overflow-hidden">
        <div className="flex w-full flex-col text-left">
          <VideoThumb state={failed ? 'failed' : 'uploading'} tintIndex={0} duration={null} />
          <div className="flex flex-col gap-2 p-3.5">
            <div className="flex items-center gap-2">
              <strong
                className={cn(
                  'min-w-0 flex-1 truncate text-sm',
                  !titled && 'font-normal text-muted-foreground',
                )}
              >
                {titled ? upload.title : 'Unnamed video'}
              </strong>
              <StatusPill state={failed ? 'failed' : 'uploading'} />
            </div>
            {upload.folderName && (
              <p className="text-xs text-muted-foreground">→ {upload.folderName}</p>
            )}
            {failed && upload.error ? (
              <p className="text-xs text-destructive">{upload.error}</p>
            ) : (
              <div className="h-1 overflow-hidden rounded bg-background">
                <div
                  className={cn(
                    'h-full bg-primary transition-all duration-300',
                    finishing && 'animate-pulse',
                  )}
                  style={{ width: queued ? '0%' : `${finishing ? 100 : pct}%` }}
                />
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs tabular-nums text-muted-foreground">{label}</span>
              <div className="flex items-center gap-2">
                {failed && (
                  <Button variant="outline" size="sm" onClick={props.onRetry}>
                    Retry
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={props.onCancel}>
                  {failed || queued ? 'Remove' : 'Cancel'}
                </Button>
              </div>
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
