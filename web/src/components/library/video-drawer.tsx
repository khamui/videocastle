import { useState } from 'react';
import { ExternalLink, Play } from 'lucide-react';

import {
  clearVideoPassword,
  deleteVideo,
  moveVideoToFolder,
  retryVideo,
  setVideoExpiry,
  setVideoPassword,
  type FolderSummary,
  type VideoSummary,
} from '../../api';
import { useFeedback } from '@/components/feedback/use-feedback';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import {
  ExpiredBadge,
  ProtectedBadge,
  StatusPill,
  VideoThumb,
} from '@/components/library/video-visuals';

const DAY = 24 * 60 * 60 * 1000;
const EXPIRY_PRESETS = [
  { value: '1', label: '24 hours' },
  { value: '3', label: '3 days' },
  { value: '7', label: '7 days' },
];

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

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
}) {
  const { video, folders, onChanged } = props;
  const { notify, reportError } = useFeedback();
  const [busy, setBusy] = useState(false);
  const [showPwdInput, setShowPwdInput] = useState(false);
  const [pwd, setPwd] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const shareUrl = `${window.location.origin}${video.shareUrl}`;

  async function run(
    fn: () => Promise<unknown>,
    successMsg: string,
    errorTitle: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      await fn();
      notify(successMsg);
      onChanged();
      return true;
    } catch (err) {
      // Operator error → persistent, copy-pasteable surface with the reason
      // code and raw diagnostic (ADR-0007/0009), never a transient toast.
      reportError(err, { title: errorTitle });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(shareUrl);
      notify('Link copied to clipboard');
    } catch {
      reportError(new Error('The browser blocked clipboard access.'), {
        title: 'Copy failed',
      });
    }
  }

  function preview(): void {
    window.open(video.shareUrl, '_blank', 'noopener,noreferrer');
  }

  async function onPwdToggle(checked: boolean): Promise<void> {
    if (checked) {
      if (!video.protected) setShowPwdInput(true);
    } else if (video.protected) {
      await run(
        () => clearVideoPassword(video.slug),
        'Password removed',
        'Could not remove password',
      );
    } else {
      setShowPwdInput(false);
      setPwd('');
    }
  }

  async function savePwd(): Promise<void> {
    if (pwd.trim().length === 0) return;
    const ok = await run(
      () => setVideoPassword(video.slug, pwd.trim()),
      'Password set',
      'Could not set password',
    );
    if (ok) {
      setPwd('');
      setShowPwdInput(false);
    }
  }

  async function onExpiryChange(value: string): Promise<void> {
    const expiresAt = value === 'never' ? null : Date.now() + Number(value) * DAY;
    await run(
      () => setVideoExpiry(video.slug, expiresAt),
      expiresAt == null ? 'Expiry cleared' : 'Link expiry updated',
      'Could not update expiry',
    );
  }

  async function onMove(value: string): Promise<void> {
    await run(
      () => moveVideoToFolder(video.slug, value === 'root' ? null : value),
      'Moved',
      'Could not move video',
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

  const expiryStatus = video.expired
    ? 'This link has expired.'
    : video.expiresAt != null
      ? `Expires ${new Date(video.expiresAt).toLocaleString()}`
      : 'Never expires';

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
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

        <Field label="Share link">
          <div className="flex gap-2">
            <input
              readOnly
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 font-mono text-xs"
            />
            <Button variant="outline" size="sm" onClick={() => void copyLink()}>
              Copy
            </Button>
            <Button variant="outline" size="sm" onClick={preview}>
              <ExternalLink className="size-4" />
            </Button>
          </div>
        </Field>

        <Field label="Password protect">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {video.protected
                ? 'A password is required to watch.'
                : 'Anyone with the link can watch.'}
            </span>
            <Switch
              checked={video.protected || showPwdInput}
              onCheckedChange={(c) => void onPwdToggle(c)}
              disabled={busy}
            />
          </div>
          {showPwdInput && !video.protected && (
            <div className="flex gap-2">
              <input
                type="password"
                autoFocus
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="New password"
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm"
              />
              <Button
                size="sm"
                onClick={() => void savePwd()}
                disabled={busy || pwd.trim().length === 0}
              >
                Save
              </Button>
            </div>
          )}
        </Field>

        <Field label="Link expiry">
          <p className="text-xs text-muted-foreground">{expiryStatus}</p>
          <Select
            onValueChange={(v) => void onExpiryChange(v)}
            disabled={busy}
          >
            <SelectTrigger>
              <SelectValue placeholder="Change link expiry…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="never">Never</SelectItem>
              {EXPIRY_PRESETS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {video.expired ? `Re-enable · ${o.label}` : o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

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

        <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
          {video.state === 'failed' && (
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
          )}

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
