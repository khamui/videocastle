import { useRef, useState } from 'react';
import { ChevronLeft, Pencil, Play } from 'lucide-react';

import {
  clearVideoPassword,
  deleteVideo,
  moveVideoToFolder,
  retryVideo,
  setVideoExpiry,
  setVideoPassword,
  setVideoPortrait,
  setVideoAutoplay,
  setVideoTitle,
  setVideoDescription,
  type FolderSummary,
  type VideoSummary,
} from '../../api';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
} from '@/components/library/drawer-parts';
import {
  ExpiredBadge,
  ProtectedBadge,
  StatusPill,
  VideoThumb,
} from '@/components/library/video-visuals';

/**
 * Video detail drawer (ADR-0008 Model 2): copy link, password, expiry, move,
 * delete — all through the existing API. Success → toast, failure → the
 * persistent copyable error surface (ADR-0009). Replaces the old inline action
 * row and its native prompts.
 */
export function VideoDrawer(props: {
  video: VideoSummary;
  folders: FolderSummary[];
  tintIndex: number;
  onChanged: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shown when the drawer was drilled into from a Folder's drawer. */
  backTo?: { label: string; onBack: () => void };
}) {
  const { video, folders } = props;
  const actions = useDrawerActions(props.onChanged);
  const { busy, run } = actions;
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function preview(): void {
    openShareLink(video.shareUrl);
  }

  async function onRename(title: string): Promise<boolean> {
    return run(
      () => setVideoTitle(video.slug, title),
      'Title updated',
      'Could not rename video',
    );
  }

  async function onDescribe(description: string | null): Promise<boolean> {
    return run(
      () => setVideoDescription(video.slug, description),
      description === null ? 'Description cleared' : 'Description updated',
      'Could not update description',
    );
  }

  async function onMove(value: string): Promise<void> {
    await run(
      () => moveVideoToFolder(video.slug, value === 'root' ? null : value),
      'Moved',
      'Could not move video',
    );
  }

  async function onPortrait(optimized: boolean): Promise<void> {
    await run(
      () => setVideoPortrait(video.slug, optimized),
      optimized ? 'Portrait optimization on' : 'Portrait optimization off',
      'Could not update portrait setting',
    );
  }

  async function onAutoplay(autoplay: boolean): Promise<void> {
    await run(
      () => setVideoAutoplay(video.slug, autoplay),
      autoplay ? 'Autoplay on' : 'Autoplay off',
      'Could not update autoplay setting',
    );
  }

  async function doDelete(): Promise<void> {
    const ok = await run(
      () => deleteVideo(video.slug),
      'Video deleted · link disabled',
      'Delete failed',
    );
    if (ok) props.onOpenChange(false);
  }

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        {props.backTo && (
          <button
            type="button"
            onClick={props.backTo.onBack}
            className="-mb-1 flex items-center gap-1 self-start bg-transparent p-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" />
            {props.backTo.label}
          </button>
        )}

        <EditableTitle title={video.title} busy={busy} onSave={onRename} />

        <EditableDescription
          description={video.description}
          busy={busy}
          onSave={onDescribe}
        />

        <div className="relative overflow-hidden rounded-lg border border-border">
          <VideoThumb
            state={video.state}
            tintIndex={props.tintIndex}
            duration={null}
          />
          <button
            type="button"
            onClick={preview}
            className="absolute inset-0 flex items-center justify-center bg-black/30 text-sm font-medium text-white opacity-0 transition-opacity hover:opacity-100"
          >
            <Play className="mr-1.5 size-4" /> Preview
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusPill state={video.state} />
          {video.protected && <ProtectedBadge label="Password-protected" />}
          {video.expired && <ExpiredBadge label="Expired" />}
        </div>

        {video.state === 'failed' && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <p className="font-medium">Transcoding failed.</p>
            {video.failureReason && (
              <p className="mt-1 font-mono">reason: {video.failureReason}</p>
            )}
            {video.failureDetail && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">
                {video.failureDetail}
              </pre>
            )}
          </div>
        )}

        <ShareLinkFields
          link={video}
          actions={actions}
          passwordHint={{
            on: 'A password is required to watch.',
            off: 'Anyone with the link can watch.',
          }}
          setPassword={(password) => setVideoPassword(video.slug, password)}
          clearPassword={() => clearVideoPassword(video.slug)}
          setExpiry={(expiresAt) => setVideoExpiry(video.slug, expiresAt)}
        />

        <Field label="Folder">
          <Select
            value={video.folderSlug ?? 'root'}
            onValueChange={(v) => void onMove(v)}
            disabled={busy}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="root">Library root</SelectItem>
              {folders.map((f) => (
                <SelectItem key={f.slug} value={f.slug}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Optimize for portrait (mobile)">
          <label className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {video.portraitOptimized
                ? 'On a portrait phone, crops to fill with the centred portrait content. No effect on desktop.'
                : 'Shown whole-frame on every screen.'}
            </span>
            <Switch
              checked={video.portraitOptimized}
              onCheckedChange={(v) => void onPortrait(v)}
              disabled={busy}
            />
          </label>
        </Field>

        <Field label="Autoplay on open">
          <label className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {video.autoplay
                ? 'Starts automatically (muted) when a viewer opens the link; they can unmute in the player.'
                : 'Viewer presses play to start.'}
            </span>
            <Switch
              checked={video.autoplay}
              onCheckedChange={(v) => void onAutoplay(v)}
              disabled={busy}
            />
          </label>
        </Field>

        <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
          {video.state === 'failed' &&
            // A transcode reads the Source. Once it has been discarded there
            // is nothing to re-encode, so Retry is shown as unavailable with
            // the reason rather than offered and then refused (ADR-0010).
            (video.storage.sourceDiscardedAt !== null ? (
              <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">
                  This Video can’t be retried.
                </p>
                <p className="mt-1">
                  Its Source was discarded on{' '}
                  {new Date(video.storage.sourceDiscardedAt).toLocaleDateString()}{' '}
                  to reclaim disk, and discarding is irreversible. Re-upload the
                  original to replace this Video.
                </p>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={() =>
                  void run(
                    () => retryVideo(video.slug),
                    'Retrying transcode',
                    'Retry failed',
                  )
                }
                disabled={busy}
              >
                Retry transcode
              </Button>
            ))}

          {confirmingDelete ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <p className="text-xs text-destructive">
                Permanently delete “{video.title}”? This removes the video and
                its Share Link stops working immediately. This can’t be undone.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void doDelete()}
                  disabled={busy}
                >
                  Delete permanently
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <SheetClose asChild>
                <Button variant="ghost" size="sm">
                  Close
                </Button>
              </SheetClose>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy}
              >
                Delete
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The title cap enforced by the server (routes.ts TITLE_MAX_LENGTH), mirrored
 * here so the input stops at the limit instead of letting the operator type a
 * name the rename will only reject.
 */
const TITLE_MAX_LENGTH = 150;

/**
 * The click-to-edit plumbing shared by the title and the description: a draft
 * buffer, an open/closed flag, and the blur/Escape handling that makes "Enter
 * or focus-loss commits, Escape reverts" behave. `commit` is given the current
 * draft and returns whether the field may close — false keeps it open (a failed
 * save), true closes it (saved, reverted, or an unchanged no-op).
 */
function useInlineEdit(commit: (draft: string) => Promise<boolean>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Escape blurs the control to cancel; without this flag the ensuing blur
  // would be read as a commit and save the reverted-away text.
  const escaping = useRef(false);

  function begin(initial: string): void {
    setDraft(initial);
    setEditing(true);
  }

  function onBlur(): void {
    if (escaping.current) {
      escaping.current = false;
      setEditing(false);
      return;
    }
    void commit(draft).then((close) => {
      if (close) setEditing(false);
    });
  }

  /** Call from a keydown to abandon the edit via the blur path. */
  function cancel(el: HTMLElement): void {
    escaping.current = true;
    el.blur();
  }

  return {
    editing,
    draft,
    setDraft,
    begin,
    onBlur,
    cancel,
  };
}

/**
 * The drawer's in-place title: the Video's name shown as the Sheet heading,
 * click-to-rename right where it sits. Enter or blur commits, Escape reverts;
 * an empty (not savable) or unchanged value just closes. Stays a `SheetTitle`
 * in both modes via `asChild`, so the drawer keeps the single accessible
 * heading Radix needs to label the dialog.
 */
function EditableTitle(props: {
  title: string;
  busy: boolean;
  onSave: (title: string) => Promise<boolean>;
}) {
  const edit = useInlineEdit(async (draft) => {
    const next = draft.trim();
    // Empty is not savable and unchanged is a no-op: either way, just close and
    // keep the current title. A real change is saved; the field stays open only
    // when the save itself fails, so the operator can retry without retyping.
    if (next.length === 0 || next === props.title) return true;
    return props.onSave(next);
  });

  if (edit.editing) {
    return (
      <SheetTitle asChild>
        <input
          autoFocus
          value={edit.draft}
          disabled={props.busy}
          maxLength={TITLE_MAX_LENGTH}
          onChange={(e) => edit.setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={edit.onBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              edit.cancel(e.currentTarget);
            }
          }}
          // 16px on small screens so iOS Safari doesn't force-zoom on focus.
          className="mr-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-base font-semibold focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </SheetTitle>
    );
  }

  return (
    <SheetTitle asChild>
      <button
        type="button"
        onClick={() => edit.begin(props.title)}
        title="Rename"
        className="group -mx-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent"
      >
        <span className="truncate">{props.title}</span>
        <Pencil className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    </SheetTitle>
  );
}

/**
 * The drawer's in-place description, shown just under the title. Unlike the
 * title a description is optional: a blank value clears it, and a Video with
 * none shows a muted prompt to add one. A textarea (descriptions run to several
 * lines), so Enter inserts a newline — Escape reverts and blur commits, same as
 * the title.
 */
function EditableDescription(props: {
  description: string | null;
  busy: boolean;
  onSave: (description: string | null) => Promise<boolean>;
}) {
  const edit = useInlineEdit(async (draft) => {
    const trimmed = draft.trim();
    const next = trimmed.length > 0 ? trimmed : null;
    // Unchanged (including blank over an already-empty description) is a no-op.
    if (next === props.description) return true;
    return props.onSave(next);
  });

  if (edit.editing) {
    return (
      <textarea
        autoFocus
        rows={3}
        value={edit.draft}
        disabled={props.busy}
        onChange={(e) => edit.setDraft(e.target.value)}
        onBlur={edit.onBlur}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            edit.cancel(e.currentTarget);
          }
        }}
        placeholder="Add a description…"
        // 16px on small screens so iOS Safari doesn't force-zoom on focus.
        className="-mt-1 min-w-0 resize-y rounded-md border border-border bg-background px-2 py-1 text-base text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => edit.begin(props.description ?? '')}
      title="Edit description"
      className="group -mx-2 -mt-1 flex items-start gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent"
    >
      <span
        className={
          props.description
            ? 'whitespace-pre-wrap text-sm text-muted-foreground'
            : 'text-sm italic text-muted-foreground/60'
        }
      >
        {props.description ?? 'Add a description…'}
      </span>
      <Pencil className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
