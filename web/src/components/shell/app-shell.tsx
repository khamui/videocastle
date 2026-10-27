import { useState } from 'react';
import {
  HardDrive,
  Library,
  Link2,
  LogOut,
  Menu,
  Settings,
  X,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import type { StorageReport } from '../../api';

// The operator shell's navigation sections. Only `library` is built in v1
// (ADR-0008 / spec: Operator & Viewer UI); the rest render placeholders.
export type Section = 'library' | 'share-links' | 'storage' | 'settings';

const NAV: { id: Section; label: string; icon: typeof Library }[] = [
  { id: 'library', label: 'Library', icon: Library },
  { id: 'share-links', label: 'Share links', icon: Link2 },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'settings', label: 'Settings', icon: Settings },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <svg aria-hidden viewBox="74 72 40 44" className="size-7">
        <path
          fill="#3dd6b0"
          d="M 76 74.398438 L 82.398438 74.398438 L 82.398438 78.398438 L 88 78.398438 L 88 74.398438 L 99.199219 74.398438 L 99.199219 78.398438 L 104.800781 78.398438 L 104.800781 74.398438 L 111.199219 74.398438 L 111.199219 93.601562 C 111.199219 104.800781 103.199219 111.199219 93.601562 114.398438 C 84 111.199219 76 104.800781 76 93.601562 Z"
        />
        <path fill="#0f1e36" d="M 89.601562 86.398438 L 89.601562 101.601562 L 101.601562 94 Z" />
      </svg>
      <span className="text-sm font-semibold tracking-tight">videocastle</span>
    </div>
  );
}

/** Bar colour by pressure: amber from the warning band, red once writes refuse. */
const BAR = {
  ok: 'bg-primary',
  warning: 'bg-warn',
  full: 'bg-destructive',
} as const;

const LABEL = {
  ok: 'text-muted-foreground',
  warning: 'text-warn',
  full: 'text-destructive',
} as const;

/**
 * Live storage meter.
 *
 * With no Quota set there is no denominator to draw a bar against, so it shows
 * what is held and what is free rather than a bar at some arbitrary fill — a
 * near-full-looking bar on an uncapped instance would be a lie. Over 100% the
 * bar stays full and turns red, and the figure beside it tells the truth
 * (ADR-0011).
 */
function StorageMeter(props: { storage: StorageReport | null }) {
  const { storage } = props;

  if (!storage) {
    return (
      <div className="rounded-lg border border-border bg-background/40 px-3 py-2.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <HardDrive className="size-3.5" />
            Storage
          </span>
          <span className="font-mono">—</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border" />
      </div>
    );
  }

  const capped = storage.quotaBytes !== null;
  const percent = storage.usedPercent ?? 0;

  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <HardDrive className="size-3.5" />
          Storage
        </span>
        <span className={cn('shrink-0 font-mono', LABEL[storage.pressure])}>
          {capped ? `${percent}%` : formatBytes(storage.totalBytes)}
        </span>
      </div>

      {capped ? (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
            <div
              className={cn('h-full rounded-full', BAR[storage.pressure])}
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>
          <p className={cn('mt-1.5 font-mono text-[10px]', LABEL[storage.pressure])}>
            {formatBytes(storage.totalBytes)} / {formatBytes(storage.quotaBytes!)}
            {percent > 100 && ' — over the ceiling'}
          </p>
        </>
      ) : (
        <p className="mt-1.5 text-[10px] text-muted-foreground/70">
          No quota set
          {storage.freeDiskBytes !== null &&
            ` · ${formatBytes(storage.freeDiskBytes)} free on disk`}
        </p>
      )}
    </div>
  );
}

function SidebarContent(props: {
  operator: string;
  section: Section;
  storage: StorageReport | null;
  onNavigate: (s: Section) => void;
  onSignOut: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <Brand />

      <nav className="flex flex-col gap-1">
        {NAV.map(({ id, label, icon: Icon }) => {
          const active = id === props.section;
          return (
            <button
              key={id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => props.onNavigate(id)}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        <StorageMeter storage={props.storage} />
        <div className="flex items-center justify-between gap-2">
          <span
            className="truncate text-xs text-muted-foreground"
            title={props.operator}
          >
            {props.operator}
          </span>
          <Button variant="ghost" size="sm" onClick={props.onSignOut}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Two-pane operator shell (ADR-0008, "Model 2"). A persistent 232px sidebar on
 * desktop; in portrait it collapses behind a hamburger into an off-canvas
 * sheet. The main pane scrolls independently.
 */
export function AppShell(props: {
  operator: string;
  section: Section;
  /** Live storage figures for the sidebar meter; null until first load. */
  storage: StorageReport | null;
  onNavigate: (s: Section) => void;
  onSignOut: () => void;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  function navigate(s: Section) {
    props.onNavigate(s);
    setMobileOpen(false);
  }

  const sidebar = (
    <SidebarContent
      operator={props.operator}
      section={props.section}
      storage={props.storage}
      onNavigate={navigate}
      onSignOut={props.onSignOut}
    />
  );

  return (
    <div className="min-h-screen overflow-x-hidden bg-background text-foreground md:grid md:grid-cols-[232px_1fr]">
      {/* Mobile top bar (portrait) */}
      <header className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
        <Brand />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open menu"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
        >
          <Menu className="size-5" />
        </Button>
      </header>

      {/* Persistent sidebar (desktop) */}
      <aside className="hidden border-r border-border bg-card md:block">
        <div className="sticky top-0 h-screen">{sidebar}</div>
      </aside>

      {/* Off-canvas sidebar (portrait) */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[270px] max-w-[85vw] border-r border-border bg-card shadow-xl">
            <div className="flex justify-end p-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close menu"
                onClick={() => setMobileOpen(false)}
              >
                <X className="size-5" />
              </Button>
            </div>
            {sidebar}
          </div>
        </div>
      )}

      {/* Main pane */}
      <main className="min-w-0">{props.children}</main>
    </div>
  );
}

/** Honest placeholder for the nav sections not built in v1. */
export function SectionPlaceholder(props: { title: string }) {
  return (
    <div className="mx-auto max-w-[960px] px-6 py-16">
      <h1 className="text-xl font-semibold">{props.title}</h1>
      <p className="mt-3 rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
        Not built yet.
      </p>
    </div>
  );
}
