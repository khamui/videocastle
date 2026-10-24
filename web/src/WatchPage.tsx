import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { getWatch, unlockWatch, type WatchView } from './api';

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'watch'; view: WatchView };

/**
 * The Viewer's Watch Page for a `/v/<slug>` Share Link. No account, no login
 * (ADR-0002). A Ready Video plays its HLS Rendition behind the Poster; a still-
 * Processing Video shows a "being prepared" screen and quietly re-checks until
 * it is Ready; anything else collapses to one generic "not available" (the
 * server never says which link existed).
 *
 * Download deterrence (ADR-0003), not prevention: segmented HLS (never a single
 * grabbable file), no download control, and a disabled context menu over the
 * player. None of this stops a determined capture, by design.
 */
export function WatchPage(props: { slug: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const view = await getWatch(props.slug);
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
  }, [props.slug]);

  // While the Video is still Processing, re-check so it starts playing on its
  // own once the worker finishes — the Viewer never has to reload the page.
  const processing = state.kind === 'watch' && state.view.state === 'processing';
  useEffect(() => {
    if (!processing) return;
    const id = setInterval(() => {
      void getWatch(props.slug).then((view) => {
        if (view) setState({ kind: 'watch', view });
      });
    }, 5000);
    return () => clearInterval(id);
  }, [processing, props.slug]);

  switch (state.kind) {
    case 'loading':
      return <WatchShell>Loading…</WatchShell>;
    case 'unavailable':
      return <Unavailable />;
    case 'watch':
      switch (state.view.state) {
        case 'ready':
          return <Player view={state.view} />;
        case 'processing':
          return <Preparing title={state.view.title} />;
        case 'failed':
          return <TemporarilyUnavailable />;
        case 'protected':
          return (
            <PasswordPrompt
              slug={props.slug}
              onUnlocked={(view) => setState({ kind: 'watch', view })}
            />
          );
      }
  }
}

/**
 * The gate for a password-protected link (ADR-0002, second factor on top of the
 * unguessable link). On the correct password the server mints a slug-scoped
 * grant cookie and returns the real view; a wrong one is rejected opaquely —
 * the page never reveals anything about the Video behind the prompt.
 */
function PasswordPrompt(props: {
  slug: string;
  onUnlocked: (view: WatchView) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <WatchShell>
      <form
        className="watch-note watch-unlock"
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
      >
        <h1>This video is protected</h1>
        <p className="muted">Enter the password to watch it.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
          autoFocus
          required
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || password.length === 0}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </WatchShell>
  );
}

function Player(props: { view: Extract<WatchView, { state: 'ready' }> }) {
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
    <WatchShell wide>
      <div className="watch-stage">
        <video
          ref={videoRef}
          className="watch-player"
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
      <h1 className="watch-title">{view.title}</h1>
      {view.description && <p className="muted watch-desc">{view.description}</p>}
    </WatchShell>
  );
}

function Preparing(props: { title: string }) {
  return (
    <WatchShell>
      <div className="watch-note">
        <div className="spinner" aria-hidden />
        <h1>{props.title}</h1>
        <p className="muted">
          This video is still being prepared. It’ll start playing here as soon as
          it’s ready — you can leave this page open or check back shortly.
        </p>
      </div>
    </WatchShell>
  );
}

function Unavailable() {
  return (
    <WatchShell>
      <div className="watch-note">
        <h1>Video not available</h1>
        <p className="muted">
          This link doesn’t point to a video that can be watched. It may have been
          removed, or the link may be incorrect.
        </p>
      </div>
    </WatchShell>
  );
}

/** A Video that resolved but whose transcode errored (GLOSSARY: Failed). */
function TemporarilyUnavailable() {
  return (
    <WatchShell>
      <div className="watch-note">
        <h1>Temporarily unavailable</h1>
        <p className="muted">
          This video can’t be played right now. Please check back later.
        </p>
      </div>
    </WatchShell>
  );
}

function WatchShell(props: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className={`watch${props.wide ? ' watch-wide' : ''}`}>{props.children}</main>
  );
}
