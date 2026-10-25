import { AlertTriangle, HardDrive } from 'lucide-react';

import { cn } from '@/lib/utils';
import { exactBytes, formatBytes } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/library/video-visuals';
import type { StorageReport, VideoSummary } from '../../api';

/**
 * What this instance holds, and what caps it.
 *
 * The Operator owns the server, so the figures are stated plainly: a Quota
 * lowered below what is stored reports over 100% rather than a bar clamped to
 * full, the space held by Failed Videos is called out (it is otherwise
 * invisible and it is the first space an Operator would want back), and the
 * per-Video list is sorted largest-first because that is the list you actually
 * need when you have to free space.
 */

function Figure(props: { label: string; bytes: number | null; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <span className="font-mono text-sm">
        {props.bytes === null ? 'unknown' : formatBytes(props.bytes)}
      </span>
      {props.hint && (
        <span className="text-[11px] text-muted-foreground/70">{props.hint}</span>
      )}
    </div>
  );
}

const BAR = {
  ok: 'bg-primary',
  warning: 'bg-warn',
  full: 'bg-destructive',
} as const;

function QuotaBar(props: { storage: StorageReport }) {
  const { storage } = props;
  if (storage.quotaBytes === null) {
    return (
      <p className="text-sm text-muted-foreground">
        No quota is set, so media is capped only by the free-disk floor below.
        Set <code className="font-mono text-xs">STORAGE_QUOTA_BYTES</code> to put
        a ceiling on it.
      </p>
    );
  }

  const percent = storage.usedPercent ?? 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-sm">
          {formatBytes(storage.totalBytes)} / {formatBytes(storage.quotaBytes)}
        </span>
        <span
          className={cn(
            'font-mono text-sm',
            storage.pressure === 'full' && 'text-destructive',
            storage.pressure === 'warning' && 'text-warn',
          )}
        >
          {percent}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-border">
        <div
          className={cn('h-full rounded-full', BAR[storage.pressure])}
          // Clamped only as a drawing instruction — the percentage beside it is
          // never clamped, so an over-quota instance still reads honestly.
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Warning band starts at {storage.warnPercent}%
        {storage.writableBytes !== null &&
          ` · ${formatBytes(storage.writableBytes)} still writable`}
      </p>
    </div>
  );
}

export function StorageSection(props: {
  storage: StorageReport | null;
  videos: VideoSummary[] | null;
}) {
  const { storage, videos } = props;

  if (!storage) {
    return (
      <div className="mx-auto max-w-[960px] px-6 py-10">
        <h1 className="text-xl font-semibold">Storage</h1>
        <p className="mt-6 text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const bySize = [...(videos ?? [])].sort(
    (a, b) => b.storage.totalBytes - a.storage.totalBytes,
  );
  const failed = bySize.filter((v) => v.state === 'failed');
  const failedBytes = failed.reduce((sum, v) => sum + v.storage.totalBytes, 0);

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Storage</h1>
        <p className="text-sm text-muted-foreground">
          What this instance holds on disk, and the ceilings its host set.
        </p>
      </header>

      <Card className="flex flex-col gap-4 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <HardDrive className="size-4" />
          Media
        </h2>
        <QuotaBar storage={storage} />
        <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
          <Figure label="Sources" bytes={storage.sourceBytes} />
          <Figure label="Renditions" bytes={storage.renditionBytes} />
          <Figure label="Posters" bytes={storage.posterBytes} />
          <Figure label="Total" bytes={storage.totalBytes} />
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-5">
        <h2 className="text-sm font-semibold">Host disk</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Figure
            label="Free on the media filesystem"
            bytes={storage.freeDiskBytes}
            hint={
              storage.freeDiskBytes === null
                ? 'The filesystem could not be read, so the floor is not being enforced.'
                : undefined
            }
          />
          <Figure
            label="Reserved floor"
            bytes={storage.minFreeDiskBytes}
            hint="MIN_FREE_DISK_BYTES"
          />
          <Figure
            label="Database file"
            bytes={storage.databaseBytes}
            hint="Not counted toward the quota"
          />
        </div>
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          Logs are written to the process’s output, not to a file videocastle
          manages, so they are not counted here either — check your container or
          service manager for those.
        </p>
      </Card>

      {failed.length > 0 && (
        <Card className="flex flex-col gap-2 border-warn/40 bg-warn/10 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-warn">
            <AlertTriangle className="size-4" />
            {formatBytes(failedBytes)} held by {failed.length} failed{' '}
            {failed.length === 1 ? 'Video' : 'Videos'}
          </h2>
          <p className="text-xs text-muted-foreground">
            A Failed Video keeps its Source so it can be retried, and those
            bytes count toward the quota. Retry them, or delete them to get the
            space back.
          </p>
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold">Videos by size</h2>
        {bySize.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing stored yet.
          </p>
        ) : (
          <ul className="flex list-none flex-col gap-2 p-0">
            {bySize.map((video) => (
              <li
                key={video.slug}
                className="flex items-center gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {video.title}
                </span>
                {video.state !== 'ready' && <StatusPill state={video.state} />}
                <span
                  className="shrink-0 font-mono text-xs"
                  title={exactBytes(video.storage.totalBytes)}
                >
                  {formatBytes(video.storage.totalBytes)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
