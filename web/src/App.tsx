import { useEffect, useState } from 'react';
import { WatchPage } from './WatchPage';
import { GalleryPage } from './GalleryPage';
import { FeedbackProvider } from '@/components/feedback/feedback-provider';
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
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [status, setStatus] = useState<TranscodingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  // The Library root lists Folders and the unfiled Videos side by side; a
  // Folder's own Videos live in its drawer, not in this grid.
  const unfiled = (videos ?? []).filter((v) => v.folderSlug === null);

  const placeholderTitles: Record<Exclude<Section, 'library'>, string> = {
    'share-links': 'Share links',
    storage: 'Storage',
    settings: 'Settings',
  };

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
            disabled={status != null && !status.available}
            onUploaded={() => void refresh()}
          />
        </div>
      </header>

      {status && !status.available && (
        <div className="banner">
          <strong>Transcoding is unavailable.</strong> ffmpeg isn’t runnable on
          the server, so uploads are paused. Install ffmpeg (or set
          <code>FFMPEG_PATH</code>) and it resumes automatically — no restart
          needed.
          {status.error && <pre className="banner-detail">{status.error}</pre>}
        </div>
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
      ) : unfiled.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
          No unfiled Videos. Upload one to get a Share Link.
        </p>
      ) : (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3">
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
      onNavigate={setSection}
      onSignOut={() => void props.onSignOut()}
    >
      {section === 'library' ? (
        libraryBody
      ) : (
        <SectionPlaceholder title={placeholderTitles[section]} />
      )}
    </AppShell>
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
