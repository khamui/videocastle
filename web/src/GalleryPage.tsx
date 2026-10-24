import { useEffect, useState } from 'react';
import { getFolder, type FolderView, type GalleryTile } from './api';

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'folder'; folder: FolderView };

/**
 * The Viewer's gallery for a `/f/<slug>` Folder Share Link. No account, no login
 * (ADR-0002). Shows the Folder's playable Videos as tiles; opening one navigates
 * to `/f/<slug>/<vslug>`, where the Watch Page plays it with a way back here. An
 * unknown (or expired) Folder collapses to the one generic "not available" — the
 * server never says which link existed.
 */
export function GalleryPage(props: { slug: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const folder = await getFolder(props.slug);
        if (cancelled) return;
        setState(folder ? { kind: 'folder', folder } : { kind: 'unavailable' });
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
    case 'folder':
      return <Gallery slug={props.slug} folder={state.folder} />;
  }
}

function Gallery(props: { slug: string; folder: FolderView }) {
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
