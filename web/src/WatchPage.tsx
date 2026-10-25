import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  getFolderVideo,
  getWatch,
  unlockFolder,
  unlockWatch,
  type WatchView,
} from './api';
import { Button } from '@/components/ui/button';

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
          return <Player view={state.view} backHref={backHref} />;
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

function Player(props: {
  view: Extract<WatchView, { state: 'ready' }>;
  backHref?: string;
}) {
  const { view } = props;
  const videoRef = useRef<HTMLVideoElement>(null);

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

  return (
    <WatchShell wide backHref={props.backHref}>
      <div className="relative w-full max-w-[960px]">
        <div className="aspect-video w-full overflow-hidden rounded-xl border border-border bg-black">
          <video
            ref={videoRef}
            className="block h-full w-full bg-black"
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
        </div>
        {/* Download-deterrence badge (ADR-0003): states plainly that saving is
            discouraged, with no pretense that capture is prevented. */}
        <span className="pointer-events-none absolute right-3 top-3 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-xs text-white/90 backdrop-blur-sm">
          ⤓ Download disabled
        </span>
      </div>
      <h1 className="mt-1 w-full max-w-[960px] text-xl font-semibold">
        {view.title}
      </h1>
      {view.description && (
        <p className="w-full max-w-[960px] text-sm text-muted-foreground">
          {view.description}
        </p>
      )}
    </WatchShell>
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
