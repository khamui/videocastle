import { useState } from 'react';
import { ChevronLeft, Play } from 'lucide-react';

import {
  clearVideoPassword,
  deleteVideo,
  moveVideoToFolder,
  retryVideo,
  setVideoExpiry,
  setVideoPassword,
  setVideoPortrait,
  setVideoAutoplay,
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

        <SheetTitle>{video.title}</SheetTitle>

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
