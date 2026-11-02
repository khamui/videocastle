import { useState } from 'react';

import type { FolderSummary } from '../../api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { LinkRow } from './share-links-page';

function videoCount(n: number): string {
  return `${n} video${n === 1 ? '' : 's'}`;
}

/**
 * Disabling a Folder is a choice, not a yes/no (ADR-0014): the gallery link
 * alone (the default), or the gallery *and* every member Video's own link. The
 * cascade is a disable-time decision only — re-enabling later never cascades —
 * so it is offered exactly here, when switching off.
 */
export function FolderDisableDialog(props: {
  folder: FolderSummary;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (cascade: boolean) => void;
}) {
  const { folder } = props;
  const [cascade, setCascade] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable “{folder.name}”?</DialogTitle>
          <DialogDescription>
            The gallery link stops working immediately and returns the same “not
            found” a Viewer sees for any dead link. Re-enable it any time — nothing
            is deleted.
          </DialogDescription>
        </DialogHeader>

        {folder.videoCount > 0 && (
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background p-3">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={cascade}
              onChange={(e) => setCascade(e.target.checked)}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">
                Also disable the {videoCount(folder.videoCount)} inside
              </span>
              <span className="text-xs text-muted-foreground">
                Each member Video’s own <code>/v/</code> link is switched off too.
                Re-enabling the Folder later won’t turn them back on — do that per
                Video.
              </span>
            </span>
          </label>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => props.onConfirm(cascade)} disabled={props.busy}>
            {cascade ? 'Disable gallery + videos' : 'Disable gallery'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The count-bearing bulk-delete confirm: states exactly how many Folders and
 * Videos (and the total links) will go, and that it can't be undone. Media is
 * purged; a selected Folder counts its nested Videos even if they weren't ticked
 * individually.
 */
export function BulkDeleteDialog(props: {
  folderCount: number;
  videoCount: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { folderCount, videoCount: vids } = props;
  const links = folderCount + vids;
  const parts: string[] = [];
  if (folderCount > 0) parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`);
  if (vids > 0) parts.push(`${vids} video${vids === 1 ? '' : 's'}`);

  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {parts.join(' + ')}?</DialogTitle>
          <DialogDescription>
            This removes {links} Share Link{links === 1 ? '' : 's'} and purges the
            media for every Video involved — including Videos inside a selected
            Folder, whether or not they were ticked. This can’t be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={props.onConfirm} disabled={props.busy}>
            Delete {links} link{links === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Per-row delete. A Video is a single irreversible confirm; a Folder reuses the
 * ADR-0006 keep/purge choice (delete its Videos too, or keep them by moving them
 * to the Library root), neither option pre-selected.
 */
export function RowDeleteDialog(props: {
  row: LinkRow;
  busy: boolean;
  onCancel: () => void;
  onDeleteVideo: () => void;
  onDeleteFolder: (mode: 'delete' | 'keep') => void;
}) {
  const { row } = props;

  if (row.kind === 'video') {
    return (
      <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{row.name}”?</DialogTitle>
            <DialogDescription>
              Its Source and Rendition are purged and the Share Link stops working
              immediately. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={props.onDeleteVideo}
              disabled={props.busy}
            >
              Delete Video
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const n = row.videoCount ?? 0;
  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{row.name}”?</DialogTitle>
          <DialogDescription>
            {n === 0
              ? 'This Folder is empty. Deleting it stops its gallery link working immediately.'
              : `Choose what happens to its ${videoCount(n)}. The gallery link stops working immediately either way.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => props.onDeleteFolder('delete')}
            disabled={props.busy}
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
            onClick={() => props.onDeleteFolder('keep')}
            disabled={props.busy}
            className="rounded-md border border-border bg-background p-3 text-left transition-colors hover:bg-accent/20 disabled:opacity-60"
          >
            <span className="block text-sm font-medium">Delete the folder only</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              The Videos move to the Library root and keep their own Share Links.
            </span>
          </button>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
