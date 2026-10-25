import { cn } from '@/lib/utils';

/** Studio Dark surface card (shadcn-style). A plain styled container. */
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card text-card-foreground',
        className,
      )}
      {...props}
    />
  );
}
