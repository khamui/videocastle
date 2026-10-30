import { useState } from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';

import {
  clearFolderPassword,
  deleteFolder,
  setFolderExpiry,
  setFolderPassword,
  setFolderPortrait,
  setFolderAutoplay,
  type FolderSummary,
  type VideoSummary,
} from '../../api';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Field,
  ShareLinkFields,
  openShareLink,
  useDrawerActions,
  type DrawerActions,
} from '@/components/library/drawer-parts';
import { VideoDrawer } from '@/components/library/video-drawer';
import {
  ExpiredBadge,
  ProtectedBadge,
  StatusPill,
  VideoThumb,
  thumbTint,
} from '@/components/library/video-visuals';

function videoCount(n: number): string {
  return `${n} video${n === 1 ? '' : 's'}`;
}

/**
 * What the open drawer is showing. Exactly one at a time — drilling into a
 * Video or raising the delete choice replaces the Folder view rather than
 * layering a second modal over it, so there is only ever one dismissable layer
 * on screen and `open` has a single meaning.
 */
type View =
  | { kind: 'folder' }
  | { kind: 'video'; slug: string }
  | { kind: 'delete' };

/**
 * Folder detail drawer (ADR-0008 Model 2): the gallery link with its password
 * and expiry, the Folder's Videos — each drilling into that Video's own drawer
 * — and delete-folder with the ADR-0006 choice. Replaces the Folder card's
 * inline action row, its native prompts, and the old in-place Library filter.
 */
export function FolderDrawer(props: {
  folder: FolderSummary;
  /** The Videos in this Folder, from the Library's already-loaded list. */
  videos: VideoSummary[];
  /** Every Folder, for the drilled-into Video's move-to-folder select. */
  folders: FolderSummary[];
  onChanged: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { folder, videos } = props;
  const actions = useDrawerActions(props.onChanged);
  const [view, setView] = useState<View>({ kind: 'folder' });

  /** Dismisses the drawer entirely, so reopening it starts at the Folder. */
  function closeAll(): void {
    setView({ kind: 'folder' });
    props.onOpenChange(false);
  }

  // Resolved against the live list, so a Video moved out or deleted from the
  // drilled drawer drops us back to this Folder rather than stranding a stale
  // copy on screen.
  const drilled =
    view.kind === 'video'
      ? (videos.find((v) => v.slug === view.slug) ?? null)
      : null;

  if (drilled) {
    return (
      <VideoDrawer
        video={drilled}
        folders={props.folders}
        tintIndex={thumbTint(drilled.slug)}
        onChanged={props.onChanged}
        open={props.open}
        onOpenChange={(open) => {
          if (!open) closeAll();
        }}
        backTo={{ label: folder.name, onBack: () => setView({ kind: 'folder' }) }}
      />
    );
  }

  if (view.kind === 'delete') {
    return (
      <DeleteFolderDialog
        folder={folder}
        actions={actions}
        open={props.open}
        onCancel={() => setView({ kind: 'folder' })}
        onDeleted={closeAll}
      />
    );
  }

  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) closeAll();
      }}
    >
      <SheetContent>
        <SheetTitle>{folder.name}</SheetTitle>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {videoCount(folder.videoCount)}
          </span>
          {folder.protected && <ProtectedBadge label="Password-protected" />}
          {folder.expired && <ExpiredBadge label="Expired" />}
        </div>

        <ShareLinkFields
          link={folder}
          actions={actions}
          passwordHint={{
            on: 'A password is required to browse the gallery.',
            off: 'Anyone with the link can browse the gallery.',
          }}
          setPassword={(password) => setFolderPassword(folder.slug, password)}
          clearPassword={() => clearFolderPassword(folder.slug)}
          setExpiry={(expiresAt) => setFolderExpiry(folder.slug, expiresAt)}
        />

        <Field label="Optimize for portrait (mobile)">
          <label className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Applies to every Video in this Folder, and to new uploads into it.
              On a portrait phone they crop to fill; no effect on desktop.
            </span>
            <Switch
              checked={folder.portraitOptimized}
              onCheckedChange={(v) =>
                void actions.run(
                  () => setFolderPortrait(folder.slug, v),
                  v
                    ? 'Portrait optimization on for this Folder'
                    : 'Portrait optimization off for this Folder',
                  'Could not update portrait setting',
                )
              }
              disabled={actions.busy}
            />
          </label>
        </Field>

        <Field label="Autoplay on open">
          <label className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Applies to every Video in this Folder, and to new uploads into it.
              Each starts automatically (muted) when a viewer opens the link;
              they can unmute in the player.
            </span>
            <Switch
              checked={folder.autoplay}
              onCheckedChange={(v) =>
                void actions.run(
                  () => setFolderAutoplay(folder.slug, v),
                  v ? 'Autoplay on for this Folder' : 'Autoplay off for this Folder',
                  'Could not update autoplay setting',
                )
              }
              disabled={actions.busy}
            />
          </label>
        </Field>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Videos
            </span>
            <button
              type="button"
              onClick={() => openShareLink(folder.shareUrl)}
              className="flex items-center gap-1 bg-transparent p-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Preview gallery
              <ExternalLink className="size-3" />
            </button>
          </div>

          {videos.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              This Folder is empty. Move a Video in from its own drawer.
            </p>
          ) : (
            <ul className="flex list-none flex-col gap-2 p-0">
              {videos.map((video) => (
                <li key={video.slug}>
                  <button
                    type="button"
                    onClick={() => setView({ kind: 'video', slug: video.slug })}
                    className="flex w-full items-center gap-3 rounded-md border border-border bg-background p-2 text-left text-foreground transition-colors hover:bg-accent/20"
                  >
                    <span className="w-14 shrink-0 overflow-hidden rounded">
                      <VideoThumb
                        state={video.state}
                        tintIndex={thumbTint(video.slug)}
                        duration={null}
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {video.title}
                    </span>
                    {video.protected && (
                      <ProtectedBadge label="Password-protected" />
                    )}
                    {video.expired && <ExpiredBadge label="Expired" />}
                    {video.state !== 'ready' && (
                      <StatusPill state={video.state} />
                    )}
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-auto flex items-center justify-between border-t border-border pt-4">
          <SheetClose asChild>
            <Button variant="ghost" size="sm">
              Close
            </Button>
          </SheetClose>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setView({ kind: 'delete' })}
            disabled={actions.busy}
          >
            Delete folder
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Deleting a Folder is a choice, not a yes/no (ADR-0006): its Videos either go
 * with it or move to the Library root. Both options are on screen before
 * anything happens, and neither is pre-selected.
 */
function DeleteFolderDialog(props: {
  folder: FolderSummary;
  actions: DrawerActions;
  open: boolean;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { folder, actions } = props;

  async function remove(mode: 'delete' | 'keep'): Promise<void> {
    const ok = await actions.run(
      () => deleteFolder(folder.slug, mode),
      mode === 'delete'
        ? `Folder and its ${videoCount(folder.videoCount)} deleted`
        : 'Folder deleted · videos moved to the Library root',
      'Could not delete Folder',
    );
    if (ok) props.onDeleted();
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{folder.name}”?</DialogTitle>
          <DialogDescription>
            {folder.videoCount === 0
              ? 'This Folder is empty. Deleting it stops its gallery link working immediately.'
              : `Choose what happens to its ${videoCount(folder.videoCount)}. The gallery link stops working immediately either way.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void remove('delete')}
            disabled={actions.busy}
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-left transition-colors hover:bg-destructive/20 disabled:opacity-60"
          >
            <span className="block text-sm font-medium text-destructive">
              Delete the folder and its videos
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Every Video in it is removed with its media, and each Video’s own
              Share Link stops working. This can’t be undone.
            </span>
          </button>

          <button
            type="button"
            onClick={() => void remove('keep')}
            disabled={actions.busy}
            className="rounded-md border border-border bg-background p-3 text-left transition-colors hover:bg-accent/20 disabled:opacity-60"
          >
            <span className="block text-sm font-medium">
              Delete the folder only
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              The Videos move to the Library root and keep their own Share
              Links.
            </span>
          </button>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onCancel}
            disabled={actions.busy}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
