import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  getFolder,
  getFolderVideo,
  getWatch,
  unlockFolder,
  unlockWatch,
  type GalleryTile,
  type WatchView,
} from './api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'watch'; view: WatchView };

/**
 * The Viewer's Watch Page. No account, no login (ADR-0002). Serves two Share
 * Link shapes: a standalone `/v/<slug>` link, and a Video opened from within its
 * Folder (`/f/<folderSlug>/<slug>`), which additionally shows a back-to-gallery
 * link. In both, a Ready Video plays its HLS Rendition behind the Poster; a
 * still-Processing Video shows a "being prepared" screen and quietly re-checks
 * until it is Ready; anything else collapses to one generic "not available" (the
 * server never says which link existed).
 *
 * The in-Folder view differs only in where its view model is fetched from (the
 * server also confirms the Video is in that Folder) and the back link — playback,
 * poster, and unlock all run through the Video's own `/api/watch/:slug/*` routes,
 * so a direct `/v/<slug>` link never reveals a Folder or its siblings.
 *
 * Download deterrence (ADR-0003), not prevention: segmented HLS (never a single
 * grabbable file), no download control, and a disabled context menu over the
 * player. None of this stops a determined capture, by design.
 */
export function WatchPage(props: { slug: string; folderSlug?: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const { slug, folderSlug } = props;
  const backHref = folderSlug ? `/f/${encodeURIComponent(folderSlug)}` : undefined;
  const fetchView = (): Promise<WatchView | null> =>
    folderSlug ? getFolderVideo(folderSlug, slug) : getWatch(slug);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const view = await fetchView();
        if (cancelled) return;
        setState(view ? { kind: 'watch', view } : { kind: 'unavailable' });
      } catch {
        if (!cancelled) setState({ kind: 'unavailable' });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, folderSlug]);

  // While the Video is still Processing, re-check so it starts playing on its
  // own once the worker finishes — the Viewer never has to reload the page.
  const processing = state.kind === 'watch' && state.view.state === 'processing';
  useEffect(() => {
    if (!processing) return;
    const id = setInterval(() => {
      void fetchView().then((view) => {
        if (view) setState({ kind: 'watch', view });
      });
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, slug, folderSlug]);

  switch (state.kind) {
    case 'loading':
      return (
        <WatchShell backHref={backHref}>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </WatchShell>
      );
    case 'unavailable':
      return <Unavailable backHref={backHref} />;
    case 'watch':
      switch (state.view.state) {
        case 'ready':
          return (
            <Player
              view={state.view}
              backHref={backHref}
              folderSlug={folderSlug}
            />
          );
        case 'processing':
          return <Preparing title={state.view.title} backHref={backHref} />;
        case 'failed':
          return <TemporarilyUnavailable backHref={backHref} />;
        case 'protected':
          // In a Folder, access is gated by the Folder, not the Video — so a
          // `protected` state here means the Folder is locked. Unlocking it
          // cascades: re-fetching then yields the playable Video with no second
          // prompt. A standalone link prompts for the Video's own password.
          return folderSlug ? (
            <FolderGate
              slug={folderSlug}
              backHref={backHref}
              onUnlocked={async () => {
                const view = await fetchView();
                setState(view ? { kind: 'watch', view } : { kind: 'unavailable' });
              }}
            />
          ) : (
            <PasswordPrompt
              slug={slug}
              backHref={backHref}
              onUnlocked={(view) => setState({ kind: 'watch', view })}
            />
          );
      }
  }
}

/**
 * The gate shown when a Video is opened from within a *protected* Folder: it
 * unlocks the Folder (never the Video), after which the Folder access cascades
 * to the Video and it plays. Mirrors {@link PasswordPrompt} but speaks to the
 * Folder unlock endpoint.
 */
function FolderGate(props: {
  slug: string;
  backHref?: string;
  onUnlocked: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <WatchShell backHref={props.backHref}>
      <Gate
        heading="This folder is protected"
        lede="Enter the password to watch it."
        password={password}
        setPassword={setPassword}
        busy={busy}
        error={error}
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const folder = await unlockFolder(props.slug, password);
            if (folder) await props.onUnlocked();
            else setError('That password is incorrect.');
          } catch {
            setError('Something went wrong. Please try again.');
          } finally {
            setBusy(false);
          }
        }}
      />
    </WatchShell>
  );
}

/**
 * The gate for a password-protected link (ADR-0002, second factor on top of the
 * unguessable link). On the correct password the server mints a slug-scoped
 * grant cookie and returns the real view; a wrong one is rejected opaquely —
 * the page never reveals anything about the Video behind the prompt.
 */
function PasswordPrompt(props: {
  slug: string;
  backHref?: string;
  onUnlocked: (view: WatchView) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <WatchShell backHref={props.backHref}>
      <Gate
        heading="This video is protected"
        lede="Enter the password to watch it."
        password={password}
        setPassword={setPassword}
        busy={busy}
        error={error}
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const view = await unlockWatch(props.slug, password);
            if (view) props.onUnlocked(view);
            else setError('That password is incorrect.');
          } catch {
            setError('Something went wrong. Please try again.');
          } finally {
            setBusy(false);
          }
        }}
      />
    </WatchShell>
  );
}

/**
 * Frame-relative zoom steps (Q4). `1` is Fit (the whole frame); the rest crop
 * into the centre, which is how a Viewer gets close on a portrait segment that
 * sits pillarboxed inside a landscape frame. Resets to Fit per Video — each one
 * is a fresh page load (the rail navigates), so the initial state does that for
 * free.
 */
const ZOOM_LEVELS = [1, 1.5, 2.5, 2.75, 3] as const;
const zoomLabel = (z: number): string => (z === 1 ? 'Fit' : `${Math.round(z * 100)}%`);

/**
 * The one shared player, used by every surface (standalone `/v/<slug>` and an
 * in-Folder `/f/<slug>/<vslug>`) so playback never diverges. It sizes its box to
 * the video's real aspect ratio — read from the Poster's intrinsic dimensions,
 * which match the Rendition — so a portrait Video fills the screen instead of
 * being pillarboxed in a fixed 16:9 box, capped at 80vh. An in-Folder view also
 * gets a sibling rail for one-tap switching.
 */
function Player(props: {
  view: Extract<WatchView, { state: 'ready' }>;
  backHref?: string;
  folderSlug?: string;
}) {
  const { view } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [zoom, setZoom] = useState<number>(1);
  // The video's width/height ratio, and 80% of the viewport height in px, so the
  // box fits any aspect without pillar/letterboxing the box itself.
  const [aspect, setAspect] = useState<number | null>(null);
  const [maxBoxHeight, setMaxBoxHeight] = useState(() =>
    typeof window === 'undefined' ? 720 : window.innerHeight * 0.8,
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Safari (and iOS) play HLS natively; everywhere else, hls.js drives
    // playback through Media Source Extensions.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = view.playlistUrl;
      return;
    }
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(view.playlistUrl);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
    // No HLS support at all — leave the poster up; there is nothing to play.
  }, [view.playlistUrl]);

  // Read the true aspect cheaply off the Poster (shown before playback anyway),
  // so the box is correctly shaped without a server round-trip or schema change.
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled && img.naturalWidth > 0 && img.naturalHeight > 0) {
        setAspect(img.naturalWidth / img.naturalHeight);
      }
    };
    img.src = view.posterUrl;
    return () => {
      cancelled = true;
    };
  }, [view.posterUrl]);

  useEffect(() => {
    const onResize = () => setMaxBoxHeight(window.innerHeight * 0.8);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Fit the box to whichever limit binds first: 960px wide, or 80vh tall.
  const boxWidth = aspect ? Math.min(960, aspect * maxBoxHeight) : undefined;

  return (
    <WatchShell wide backHref={props.backHref}>
      <div className="relative mx-auto w-full max-w-[960px]">
        <div
          className="relative mx-auto max-w-full overflow-hidden rounded-xl border border-border bg-black"
          style={{
            width: boxWidth ? `${boxWidth}px` : '100%',
            aspectRatio: String(aspect ?? 16 / 9),
          }}
        >
          <video
            ref={videoRef}
            className="block h-full w-full bg-black object-contain transition-transform duration-200"
            style={{ transform: `scale(${zoom})` }}
            controls
            playsInline
            poster={view.posterUrl}
            preload="none"
            // Deterrence (ADR-0003): hide the browser's download affordance and
            // the right-click "save video" menu. Not a guarantee — just friction.
            controlsList="nodownload noplaybackrate noremoteplayback"
            disablePictureInPicture
            disableRemotePlayback
            onContextMenu={(e) => e.preventDefault()}
          />
          {/* Zoom control (Q4): frame-relative steps, top-left so it clears the
              download badge; always visible, resets to Fit on each Video. */}
          <div className="absolute left-3 top-3 flex overflow-hidden rounded-md bg-black/70 text-xs text-white/90 backdrop-blur-sm">
            {ZOOM_LEVELS.map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => setZoom(z)}
                aria-pressed={zoom === z}
                className={cn(
                  'px-2 py-1 tabular-nums transition-colors',
                  zoom === z ? 'bg-white/25 text-white' : 'hover:bg-white/10',
                )}
              >
                {zoomLabel(z)}
              </button>
            ))}
          </div>
          {/* Download-deterrence badge (ADR-0003): states plainly that saving is
              discouraged, with no pretense that capture is prevented. */}
          <span className="pointer-events-none absolute right-3 top-3 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-xs text-white/90 backdrop-blur-sm">
            ⤓ Download disabled
          </span>
        </div>
      </div>
      <h1 className="mt-1 w-full max-w-[960px] text-xl font-semibold">
        {view.title}
      </h1>
      {view.description && (
        <p className="w-full max-w-[960px] text-sm text-muted-foreground">
          {view.description}
        </p>
      )}
      {props.folderSlug && (
        <SiblingRail folderSlug={props.folderSlug} currentSlug={view.slug} />
      )}
    </WatchShell>
  );
}

/**
 * The in-Folder filmstrip (Model A): the Folder's other Videos as thumbnails, so
 * a Viewer can hop between them without going back to the Gallery first. Plain
 * `<a>` links — switching is a full page load into this same shared Player (no
 * client router). Hidden when the Folder has only the one Video.
 */
function SiblingRail(props: { folderSlug: string; currentSlug: string }) {
  const { folderSlug, currentSlug } = props;
  const [tiles, setTiles] = useState<GalleryTile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getFolder(folderSlug)
      .then((folder) => {
        if (!cancelled && folder && !folder.protected) setTiles(folder.videos);
      })
      .catch(() => {
        /* a rail is a convenience; its absence is not worth an error */
      });
    return () => {
      cancelled = true;
    };
  }, [folderSlug]);

  if (!tiles || tiles.length <= 1) return null;

  return (
    <div className="w-full max-w-[960px]">
      <ul className="flex list-none gap-3 overflow-x-auto p-0 pb-1">
        {tiles.map((tile) => {
          const current = tile.slug === currentSlug;
          return (
            <li key={tile.slug} className="shrink-0">
              <a
                href={
                  current
                    ? undefined
                    : `/f/${encodeURIComponent(folderSlug)}/${encodeURIComponent(tile.slug)}`
                }
                aria-current={current ? 'true' : undefined}
                className="block w-32 no-underline"
              >
                <div
                  className={cn(
                    'aspect-video rounded-md bg-[#1b1f28] bg-cover bg-center',
                    current
                      ? 'ring-2 ring-primary'
                      : 'opacity-80 transition-opacity hover:opacity-100',
                  )}
                  style={
                    tile.posterUrl
                      ? { backgroundImage: `url(${tile.posterUrl})` }
                      : undefined
                  }
                />
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {tile.title}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Preparing(props: { title: string; backHref?: string }) {
  return (
    <WatchShell backHref={props.backHref}>
      <Note>
        <div
          className="h-9 w-9 animate-spin rounded-full border-[3px] border-border border-t-primary"
          aria-hidden
        />
        <h1 className="text-xl font-semibold">{props.title}</h1>
        <p className="leading-relaxed text-muted-foreground">
          This video is still being prepared. It’ll start playing here as soon as
          it’s ready — you can leave this page open or check back shortly.
        </p>
      </Note>
    </WatchShell>
  );
}

function Unavailable(props: { backHref?: string }) {
  return (
    <WatchShell backHref={props.backHref}>
      <Note>
        <h1 className="text-xl font-semibold">Video not available</h1>
        <p className="leading-relaxed text-muted-foreground">
          This link doesn’t point to a video that can be watched. It may have been
          removed, or the link may be incorrect.
        </p>
      </Note>
    </WatchShell>
  );
}

/** A Video that resolved but whose transcode errored (GLOSSARY: Failed). */
function TemporarilyUnavailable(props: { backHref?: string }) {
  return (
    <WatchShell backHref={props.backHref}>
      <Note>
        <h1 className="text-xl font-semibold">Temporarily unavailable</h1>
        <p className="leading-relaxed text-muted-foreground">
          This video can’t be played right now. Please check back later.
        </p>
      </Note>
    </WatchShell>
  );
}

/** A reusable password gate body (video or folder), shared by both prompts. */
function Gate(props: {
  heading: string;
  lede: string;
  password: string;
  setPassword: (value: string) => void;
  busy: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void | Promise<void>;
}) {
  return (
    <form
      className="flex w-full max-w-[320px] flex-col items-stretch gap-3 text-center"
      onSubmit={props.onSubmit}
    >
      <h1 className="text-xl font-semibold">{props.heading}</h1>
      <p className="text-sm text-muted-foreground">{props.lede}</p>
      <input
        type="password"
        className="rounded-lg border border-input bg-background px-3 py-2.5 text-center text-base text-foreground outline-none focus:border-ring"
        value={props.password}
        onChange={(e) => props.setPassword(e.target.value)}
        autoComplete="off"
        autoFocus
        required
      />
      {props.error && <p className="text-sm text-destructive">{props.error}</p>}
      <Button type="submit" disabled={props.busy || props.password.length === 0}>
        {props.busy ? 'Unlocking…' : 'Unlock'}
      </Button>
    </form>
  );
}

/** A centered message block (loading / processing / failed / 404). */
function Note(props: { children: React.ReactNode }) {
  return (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-3 text-center">
      {props.children}
    </div>
  );
}

function WatchShell(props: {
  children: React.ReactNode;
  wide?: boolean;
  /** When set, a back-to-gallery link (the Video was opened from within a Folder). */
  backHref?: string;
}) {
  return (
    <main
      className={`flex min-h-screen w-full flex-col items-center gap-4 p-6 ${
        props.wide ? 'justify-start pt-10' : 'justify-center'
      }`}
    >
      {props.backHref && (
        <a
          className="w-full max-w-[960px] text-sm text-muted-foreground no-underline hover:text-foreground"
          href={props.backHref}
        >
          ← Back to gallery
        </a>
      )}
      {props.children}
    </main>
  );
}
