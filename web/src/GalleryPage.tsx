import { useEffect, useState } from 'react';
import {
  getFolder,
  unlockFolder,
  type FolderView,
  type GalleryTile,
} from './api';

type OpenFolder = Extract<FolderView, { protected: false }>;

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'locked' }
  | { kind: 'open'; folder: OpenFolder };

/**
 * The Viewer's gallery for a `/f/<slug>` Folder Share Link. No account, no login
 * (ADR-0002). A protected Folder prompts once for its password; after unlocking,
 * its Videos play without a second prompt (the Folder→Video cascade). Otherwise
 * it shows the Folder's playable Videos as tiles — opening one navigates to
 * `/f/<slug>/<vslug>`, where the Watch Page plays it with a way back here. An
 * unknown or expired Folder collapses to the one generic "not available".
 */
export function GalleryPage(props: { slug: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const folder = await getFolder(props.slug);
        if (cancelled) return;
        if (!folder) setState({ kind: 'unavailable' });
        else if (folder.protected) setState({ kind: 'locked' });
        else setState({ kind: 'open', folder });
      } catch {
        if (!cancelled) setState({ kind: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.slug]);

  switch (state.kind) {
    case 'loading':
      return <GalleryShell>Loading…</GalleryShell>;
    case 'unavailable':
      return <Unavailable />;
    case 'locked':
      return (
        <FolderPasswordPrompt
          slug={props.slug}
          onUnlocked={(folder) => setState({ kind: 'open', folder })}
        />
      );
    case 'open':
      return <Gallery slug={props.slug} folder={state.folder} />;
  }
}

/**
 * The gate for a password-protected Folder (ADR-0002, second factor on top of
 * the unguessable link). On the correct password the server mints a Folder-scoped
 * grant cookie — which cascades to the Folder's Videos — and returns the open
 * gallery; a wrong one is rejected opaquely, revealing nothing about the Folder.
 */
function FolderPasswordPrompt(props: {
  slug: string;
  onUnlocked: (folder: OpenFolder) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <GalleryShell>
      <form
        className="watch-note watch-unlock"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const folder = await unlockFolder(props.slug, password);
            if (folder) props.onUnlocked(folder);
            else setError('That password is incorrect.');
          } catch {
            setError('Something went wrong. Please try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>This folder is protected</h1>
        <p className="muted">Enter the password to see what’s inside.</p>
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
    </GalleryShell>
  );
}

function Gallery(props: { slug: string; folder: OpenFolder }) {
  const { slug, folder } = props;
  return (
    <GalleryShell wide>
      <h1 className="gallery-title">{folder.name}</h1>
      {folder.videos.length === 0 ? (
        <p className="muted gallery-empty">There’s nothing to watch here yet.</p>
      ) : (
        <ul className="gallery-grid">
          {folder.videos.map((tile) => (
            <Tile key={tile.slug} folderSlug={slug} tile={tile} />
          ))}
        </ul>
      )}
    </GalleryShell>
  );
}

function Tile(props: { folderSlug: string; tile: GalleryTile }) {
  const { folderSlug, tile } = props;
  const href = `/f/${encodeURIComponent(folderSlug)}/${encodeURIComponent(tile.slug)}`;
  return (
    <li>
      <a className="gallery-tile" href={href}>
        <div
          className="gallery-thumb"
          style={
            tile.posterUrl
              ? { backgroundImage: `url(${tile.posterUrl})` }
              : undefined
          }
        >
          {tile.protected && (
            <span className="gallery-lock" title="Password-protected">
              🔒
            </span>
          )}
          {tile.durationSeconds != null && (
            <span className="duration">{formatDuration(tile.durationSeconds)}</span>
          )}
        </div>
        <span className="gallery-tile-title">{tile.title}</span>
      </a>
    </li>
  );
}

function Unavailable() {
  return (
    <GalleryShell>
      <div className="watch-note">
        <h1>Not available</h1>
        <p className="muted">
          This link doesn’t point to a folder that can be viewed. It may have been
          removed, or the link may be incorrect.
        </p>
      </div>
    </GalleryShell>
  );
}

function GalleryShell(props: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className={`watch${props.wide ? ' watch-wide' : ''}`}>{props.children}</main>
  );
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
