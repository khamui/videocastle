import type { Clock } from '../ports/clock';
import type { VideoRepo } from './video-repo';
import type { FolderRepo } from './folder-repo';
import { isExpired } from './routes';

/**
 * Per-link preview metadata injected into the SPA shell's `<head>` so a Share
 * Link pasted into a messenger shows the Video/Folder title instead of the same
 * generic card every time (ADR-0012). Deliberately text only — a title and
 * optional description, never an `og:image` — so no frame of the Video is ever
 * handed to a link-preview crawler to fetch or cache off the Operator's server.
 */
export interface PreviewMeta {
  title: string;
  description: string | null;
}

/**
 * HTML-escapes text for safe interpolation into both element text and
 * double-quoted attributes. The title/description are Operator-authored, so a
 * crafted value must never be able to break out and inject markup into the
 * shell we serve.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Injects Open Graph / Twitter preview tags (title + optional description, no
 * image) into the built `index.html` and rewrites its `<title>`. A pure string
 * transform: with `meta` null it returns the shell untouched, which is the
 * generic, opaque case (ADR-0002) a crawler sees for an unknown, expired,
 * protected, or not-yet-Ready link.
 */
export function injectShareMeta(html: string, meta: PreviewMeta | null): string {
  if (!meta) return html;

  const title = escapeHtml(meta.title);
  const description = meta.description ? escapeHtml(meta.description) : null;

  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    ...(description
      ? [
          `<meta name="description" content="${description}" />`,
          `<meta property="og:description" content="${description}" />`,
          `<meta name="twitter:description" content="${description}" />`,
        ]
      : []),
  ].join('\n    ');

  // Insert the preview tags just before </head> so the document's charset meta
  // stays first (meta order is otherwise immaterial), and rewrite the shell's
  // <title> to the real one.
  return html
    .replace(/<\/head>/i, `  ${tags}\n  </head>`)
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
}

/**
 * Resolves the preview a Share Link earns, reusing the same liveness rules as
 * the Viewer surface so a preview can never reveal more than opening the link
 * would (ADR-0002). Only a Ready, non-expired, unprotected target gets a title;
 * everything else — unknown, expired, protected, Processing, Failed — resolves
 * to null and falls back to the generic shell.
 */
export function createPreviewResolver(deps: {
  repo: VideoRepo;
  folderRepo: FolderRepo;
  clock: Clock;
}) {
  const { repo, folderRepo, clock } = deps;

  async function video(slug: string): Promise<PreviewMeta | null> {
    const found = await repo.findBySlug(slug);
    if (!found) return null;
    if (found.state !== 'ready') return null;
    if (found.passwordHash !== null) return null;
    if (isExpired(found, clock.now())) return null;
    return { title: found.title, description: found.description };
  }

  async function folder(slug: string): Promise<PreviewMeta | null> {
    const found = await folderRepo.findBySlug(slug);
    if (!found) return null;
    if (found.passwordHash !== null) return null;
    if (isExpired(found, clock.now())) return null;
    return { title: found.name, description: null };
  }

  /**
   * A Video opened from within its Folder (`/f/<slug>/<vslug>`). Gated by the
   * Folder, exactly like the Viewer route: a protected or expired Folder yields
   * nothing, and the Video must actually live in it. The Video's own password
   * is not re-checked — an open Folder's gallery already lists its Videos by
   * title (the Folder→Video cascade), so the preview reveals no more.
   */
  async function folderVideo(
    folderSlug: string,
    videoSlug: string,
  ): Promise<PreviewMeta | null> {
    const parent = await folderRepo.findBySlug(folderSlug);
    if (!parent) return null;
    if (parent.passwordHash !== null) return null;
    if (isExpired(parent, clock.now())) return null;

    const found = await repo.findBySlug(videoSlug);
    if (!found || found.folderId !== parent.id) return null;
    if (found.state !== 'ready') return null;
    if (isExpired(found, clock.now())) return null;
    return { title: found.title, description: found.description };
  }

  return { video, folder, folderVideo };
}
