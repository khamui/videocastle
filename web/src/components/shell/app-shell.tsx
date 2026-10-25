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
import { Button } from '@/components/ui/button';

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
      <span
        aria-hidden
        className="size-7 rounded-lg bg-gradient-to-br from-primary to-ok"
      />
      <span className="text-sm font-semibold tracking-tight">videocastle</span>
    </div>
  );
}

// Placeholder storage meter. There is no storage-accounting endpoint in v1, so
// this is deliberately not live data (spec: Operator & Viewer UI).
function StorageMeter() {
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <HardDrive className="size-3.5" />
          Storage
        </span>
        <span className="font-mono">— / — GB</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div className="h-full w-1/3 rounded-full bg-muted-foreground/40" />
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground/70">
        Metering coming soon — not live
      </p>
    </div>
  );
}

function SidebarContent(props: {
  operator: string;
  section: Section;
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
        <StorageMeter />
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
