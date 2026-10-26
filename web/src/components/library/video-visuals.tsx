import { Lock } from 'lucide-react';

import { cn } from '@/lib/utils';

// Steady per-slug placeholder tints, mirroring the prototype's thumbnail
// gradients until real posters render.
const THUMB_GRADIENTS = [
  'linear-gradient(135deg,#6a7fd6,#9c6ae0)',
  'linear-gradient(135deg,#e08a5b,#e0c35b)',
  'linear-gradient(135deg,#3f6f6a,#6abf9c)',
  'linear-gradient(135deg,#b0505f,#e07a8a)',
  'linear-gradient(135deg,#4a63a8,#6ab0d3)',
];

/** 16:9 placeholder thumbnail with an optional duration badge. */
export function VideoThumb(props: {
  state: string;
  tintIndex: number;
  duration: string | null;
}) {
  const style: React.CSSProperties =
    props.state === 'uploading'
      ? {
          // Same "in progress" stripes as processing, in the brand hue so the
          // upload phase reads as distinct from transcoding.
          backgroundImage:
            'repeating-linear-gradient(45deg,#2b2f3a,#2b2f3a 10px,#35306a 10px,#35306a 20px)',
        }
      : props.state === 'processing'
        ? {
            backgroundImage:
              'repeating-linear-gradient(45deg,#2b2f3a,#2b2f3a 10px,#333845 10px,#333845 20px)',
          }
        : props.state === 'failed'
          ? { backgroundColor: '#3a2a2e' }
          : { backgroundImage: THUMB_GRADIENTS[props.tintIndex] };
  return (
    <div className="relative aspect-video" style={style}>
      {props.duration && (
        <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
          {props.duration}
        </span>
      )}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  ready: 'bg-ok/15 text-ok',
  uploading: 'bg-primary/15 text-primary',
  processing: 'bg-warn/15 text-warn',
  failed: 'bg-destructive/15 text-destructive',
  expired: 'bg-destructive/15 text-destructive',
};

/** Color-coded Video state pill. */
export function StatusPill({ state }: { state: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        STATUS_STYLES[state] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {state}
    </span>
  );
}

/** Small lock marker for a password-protected Video or Folder. */
export function ProtectedBadge({ label }: { label: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full bg-muted-foreground/15 p-1 text-muted-foreground"
      title={label}
    >
      <Lock className="size-3" />
    </span>
  );
}

/** "expired" pill for a dead Share Link. */
export function ExpiredBadge({ label }: { label: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive"
      title={label}
    >
      expired
    </span>
  );
}

/**
 * Stable 0–4 tint index from a slug, so a Video's placeholder thumbnail keeps
 * the same colour everywhere it appears (card, drawer, Folder video list).
 */
export function thumbTint(slug: string): number {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) | 0;
  return Math.abs(hash) % THUMB_GRADIENTS.length;
}
