import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type Row,
  type RowSelectionState,
  type VisibilityState,
} from '@tanstack/react-table';
import {
  ChevronRight,
  Copy,
  ExternalLink,
  Film,
  Folder,
  Columns3,
  Power,
  PowerOff,
  Search,
  Trash2,
} from 'lucide-react';

import {
  deleteFolder,
  deleteVideo,
  listLinks,
  setFolderDisabled,
  setVideoDisabled,
  type FolderSummary,
  type VideoSummary,
} from '../../api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useFeedback } from '@/components/feedback/use-feedback';
import { openShareLink } from '@/components/library/drawer-parts';
import { ProtectedBadge, StatusPill } from '@/components/library/video-visuals';
import { FolderDisableDialog, BulkDeleteDialog, RowDeleteDialog } from './dialogs';

/**
 * One row in the Share Links table: a Folder (with its member Videos as
 * `subRows`) or a single Video (a Folder member, or one sitting in the Library
 * root at the top level). A flat view model over the two shareable units
 * (ADR-0006) so the headless table treats them uniformly.
 */
export interface LinkRow {
  /** Stable row id: `f:<slug>` or `v:<slug>`, so selection survives a reload. */
  id: string;
  kind: 'folder' | 'video';
  slug: string;
  name: string;
  /** Root-relative Viewer path (`/v/<slug>` or `/f/<slug>`). */
  url: string;
  protected: boolean;
  expired: boolean;
  disabled: boolean;
  /** Video lifecycle state, or null for a Folder. */
  state: VideoSummary['state'] | null;
  /** The owning Folder's name for a Video in a Folder, else null. */
  folderPath: string | null;
  createdAt: number;
  /** Member Video count for a Folder, else null. */
  videoCount: number | null;
  /** The source record, for actions. */
  video?: VideoSummary;
  folder?: FolderSummary;
  subRows?: LinkRow[];
}

/** The status a link reads as, Expired winning over Disabled (ADR-0014). */
type LinkStatus = 'active' | 'disabled' | 'expired';
function statusOf(row: { expired: boolean; disabled: boolean }): LinkStatus {
  if (row.expired) return 'expired';
  if (row.disabled) return 'disabled';
  return 'active';
}

/** The CountsBar chips double as filters; `null` means "everything". */
type StatusFilter = 'active' | 'disabled' | 'expired' | 'protected' | null;
type TypeFilter = 'all' | 'videos' | 'folders';

export function ShareLinksPage(props: { onChanged?: () => void }) {
  const { notify, reportError } = useFeedback();
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { videos: v, folders: f } = await listLinks();
      setVideos(v);
      setFolders(f);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load Share Links');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Reloads this view and nudges the parent so the Library stays in sync. */
  const refresh = useCallback(async () => {
    await load();
    props.onChanged?.();
  }, [load, props]);

  // Filters (not persisted — they reset on reload, by design).
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>(null);
  const [type, setType] = useState<TypeFilter>('all');

  // Table UI state.
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    name: false,
    protected: false,
    expiry: false,
    lifecycle: false,
    folderPath: false,
    created: false,
  });

  // Dialog state: a per-row delete, a Folder-disable (gallery-only vs cascade),
  // or the count-bearing bulk delete.
  const [rowDelete, setRowDelete] = useState<LinkRow | null>(null);
  const [folderDisable, setFolderDisable] = useState<FolderSummary | null>(null);
  const [bulkDelete, setBulkDelete] = useState(false);

  const foldersBySlug = useMemo(
    () => new Map(folders.map((f) => [f.slug, f])),
    [folders],
  );

  /** The full tree: Folder rows with their member Videos, then root Videos. */
  const allRows = useMemo<LinkRow[]>(() => {
    const videosByFolder = new Map<string, VideoSummary[]>();
    const rootVideos: VideoSummary[] = [];
    for (const v of videos) {
      if (v.folderSlug === null) rootVideos.push(v);
      else {
        const list = videosByFolder.get(v.folderSlug) ?? [];
        list.push(v);
        videosByFolder.set(v.folderSlug, list);
      }
    }
    const videoRow = (v: VideoSummary): LinkRow => ({
      id: `v:${v.slug}`,
      kind: 'video',
      slug: v.slug,
      name: v.title,
      url: `/v/${v.slug}`,
      protected: v.protected,
      expired: v.expired,
      disabled: v.disabled,
      state: v.state,
      folderPath: v.folderSlug ? foldersBySlug.get(v.folderSlug)?.name ?? null : null,
      createdAt: v.createdAt,
      videoCount: null,
      video: v,
    });
    const folderRows = folders.map<LinkRow>((f) => ({
      id: `f:${f.slug}`,
      kind: 'folder',
      slug: f.slug,
      name: f.name,
      url: `/f/${f.slug}`,
      protected: f.protected,
      expired: f.expired,
      disabled: f.disabled,
      state: null,
      folderPath: null,
      createdAt: f.createdAt,
      videoCount: f.videoCount,
      folder: f,
      subRows: (videosByFolder.get(f.slug) ?? []).map(videoRow),
    }));
    return [...folderRows, ...rootVideos.map(videoRow)];
  }, [videos, folders, foldersBySlug]);

  const filtering = search.trim() !== '' || status !== null || type !== 'all';

  /** Leaf predicate: does this one row (ignoring children) pass the filters? */
  const rowMatches = useCallback(
    (row: LinkRow): boolean => {
      const text = search.trim().toLowerCase();
      if (text && !row.name.toLowerCase().includes(text) && !row.url.toLowerCase().includes(text)) {
        return false;
      }
      if (type === 'videos' && row.kind !== 'video') return false;
      if (type === 'folders' && row.kind !== 'folder') return false;
      switch (status) {
        case 'active':
          return !row.disabled && !row.expired;
        case 'disabled':
          return row.disabled;
        case 'expired':
          return row.expired;
        case 'protected':
          return row.protected;
        default:
          return true;
      }
    },
    [search, status, type],
  );

  /** Prunes the tree to matching rows; a Folder stays if any child matches. */
  const visibleRows = useMemo<LinkRow[]>(() => {
    const prune = (rows: LinkRow[]): LinkRow[] => {
      const out: LinkRow[] = [];
      for (const r of rows) {
        if (r.kind === 'folder') {
          const kids = prune(r.subRows ?? []);
          if (rowMatches(r) || kids.length > 0) out.push({ ...r, subRows: kids });
        } else if (rowMatches(r)) {
          out.push(r);
        }
      }
      return out;
    };
    return prune(allRows);
  }, [allRows, rowMatches]);

  const columns = useMemo<ColumnDef<LinkRow>[]>(() => {
    return [
      {
        id: 'select',
        enableHiding: false,
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Select all"
            className="size-4 cursor-pointer align-middle accent-primary"
            checked={table.getIsAllRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = table.getIsSomeRowsSelected();
            }}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <div
            className="flex items-center gap-1.5"
            style={{ paddingLeft: `${row.depth * 20}px` }}
          >
            <input
              type="checkbox"
              aria-label={`Select ${row.original.name}`}
              className="size-4 cursor-pointer accent-primary"
              checked={row.getIsSelected()}
              ref={(el) => {
                if (el) el.indeterminate = row.getIsSomeSelected();
              }}
              onChange={row.getToggleSelectedHandler()}
            />
            {row.getCanExpand() ? (
              <button
                type="button"
                aria-label={row.getIsExpanded() ? 'Collapse' : 'Expand'}
                onClick={row.getToggleExpandedHandler()}
                className="flex size-5 items-center justify-center rounded bg-transparent p-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight
                  className={cn('size-4 transition-transform', row.getIsExpanded() && 'rotate-90')}
                />
              </button>
            ) : (
              <span className="inline-block size-5" />
            )}
          </div>
        ),
      },
      {
        id: 'url',
        header: 'URL',
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5 font-mono text-xs">
            {row.original.kind === 'folder' ? (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Film className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {row.original.url}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusBadge row={row.original} />,
      },
      {
        id: 'name',
        header: 'Name',
        cell: ({ row }) => <span className="truncate text-sm">{row.original.name}</span>,
      },
      {
        id: 'protected',
        header: 'Protected',
        cell: ({ row }) =>
          row.original.protected ? (
            <ProtectedBadge label="Password-protected" />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: 'expiry',
        header: 'Expiry',
        cell: ({ row }) => {
          const v = row.original.video;
          const f = row.original.folder;
          const expiresAt = v ? v.expiresAt : f ? f.expiresAt : null;
          return (
            <span className="text-xs text-muted-foreground">
              {expiresAt == null ? 'Never' : new Date(expiresAt).toLocaleDateString()}
            </span>
          );
        },
      },
      {
        id: 'lifecycle',
        header: 'Lifecycle',
        cell: ({ row }) =>
          row.original.state ? (
            <StatusPill state={row.original.state} />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: 'folderPath',
        header: 'Folder',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.kind === 'folder'
              ? `${row.original.videoCount} video${row.original.videoCount === 1 ? '' : 's'}`
              : (row.original.folderPath ?? 'Library root')}
          </span>
        ),
      },
      {
        id: 'created',
        header: 'Created',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {new Date(row.original.createdAt).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: 'actions',
        enableHiding: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <RowActions
            row={row.original}
            busy={busy}
            onCopy={() => void copy(row.original.url)}
            onToggleDisabled={() => void toggleRowDisabled(row.original)}
            onDelete={() => setRowDelete(row.original)}
          />
        ),
      },
    ];
    // Handlers are referenced through stable callbacks / state below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const table = useReactTable({
    data: visibleRows,
    columns,
    state: {
      rowSelection,
      columnVisibility,
      expanded: filtering ? true : expanded,
    },
    getRowId: (row) => row.id,
    getSubRows: (row) => row.subRows,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onExpandedChange: setExpanded,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  // --- Actions -------------------------------------------------------------

  async function copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${url}`);
      notify('Link copied to clipboard');
    } catch {
      reportError(new Error('The browser blocked clipboard access.'), { title: 'Copy failed' });
    }
  }

  /** Runs a mutation with the shared busy flag + operator feedback (ADR-0007/0009). */
  const run = useCallback(
    async (fn: () => Promise<unknown>, successMsg: string, errorTitle: string): Promise<boolean> => {
      setBusy(true);
      try {
        await fn();
        await refresh();
        notify(successMsg);
        return true;
      } catch (err) {
        reportError(err, { title: errorTitle });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, notify, reportError],
  );

  /** Per-row disable/re-enable. A Folder disable opens the cascade dialog. */
  async function toggleRowDisabled(row: LinkRow): Promise<void> {
    if (row.kind === 'folder' && row.folder) {
      if (!row.disabled) {
        setFolderDisable(row.folder); // ask gallery-only vs. also-inside
        return;
      }
      await run(
        () => setFolderDisabled(row.slug, false),
        'Gallery link re-enabled',
        'Could not re-enable the gallery link',
      );
      return;
    }
    await run(
      () => setVideoDisabled(row.slug, !row.disabled),
      row.disabled ? 'Link re-enabled' : 'Link disabled',
      'Could not update the link',
    );
  }

  // --- Bulk ----------------------------------------------------------------

  const selected = table.getSelectedRowModel().flatRows.map((r) => r.original);
  const selectedFolderSlugs = new Set(
    selected.filter((r) => r.kind === 'folder').map((r) => r.slug),
  );
  const selectedVideos = selected.filter((r) => r.kind === 'video');

  /** All Videos a bulk delete would purge: selected ones + everything under a selected Folder. */
  const bulkDeleteTargets = useMemo(() => {
    const videoSlugs = new Set<string>();
    for (const v of videos) {
      if (selectedVideos.some((r) => r.slug === v.slug)) videoSlugs.add(v.slug);
      if (v.folderSlug && selectedFolderSlugs.has(v.folderSlug)) videoSlugs.add(v.slug);
    }
    return { folders: [...selectedFolderSlugs], videos: [...videoSlugs] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSelection, videos]);

  async function bulkSetDisabled(disabled: boolean): Promise<void> {
    const folderSlugs = [...selectedFolderSlugs];
    const videoSlugs = selectedVideos.map((r) => r.slug);
    const ok = await run(
      async () => {
        // Folder selection already implies its member Videos (they are selected
        // too), so disabling each selected Video covers the cascade; the Folder
        // call handles its own gallery link (gallery-only — no double cascade).
        for (const slug of folderSlugs) await setFolderDisabled(slug, disabled, false);
        for (const slug of videoSlugs) await setVideoDisabled(slug, disabled);
      },
      disabled ? 'Selected links disabled' : 'Selected links re-enabled',
      disabled ? 'Could not disable every link' : 'Could not re-enable every link',
    );
    if (ok) setRowSelection({});
  }

  async function confirmBulkDelete(): Promise<void> {
    const ok = await run(
      async () => {
        // Purge selected Folders (cascades to their Videos), then any selected
        // Video that isn't already going with a selected Folder.
        for (const slug of bulkDeleteTargets.folders) await deleteFolder(slug, 'delete');
        for (const v of selectedVideos) {
          const inDeletedFolder = v.video?.folderSlug && selectedFolderSlugs.has(v.video.folderSlug);
          if (!inDeletedFolder) await deleteVideo(v.slug);
        }
      },
      'Selected links deleted',
      'Could not delete every selected link',
    );
    if (ok) {
      setRowSelection({});
      setBulkDelete(false);
    }
  }

  // --- Counts --------------------------------------------------------------

  const counts = useMemo(() => {
    const rows: { disabled: boolean; expired: boolean; protected: boolean }[] = [
      ...videos.map((v) => ({ disabled: v.disabled, expired: v.expired, protected: v.protected })),
      ...folders.map((f) => ({ disabled: f.disabled, expired: f.expired, protected: f.protected })),
    ];
    return {
      total: rows.length,
      active: rows.filter((r) => !r.disabled && !r.expired).length,
      disabled: rows.filter((r) => r.disabled).length,
      expired: rows.filter((r) => r.expired).length,
      protected: rows.filter((r) => r.protected).length,
    };
  }, [videos, folders]);

  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());
  const selectionCount = selected.length;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Share links</h1>
        <p className="text-sm text-muted-foreground">
          Every Video and Folder link in one place — switch links off or back on, or remove them.
        </p>
      </header>

      {loadError && <p className="error">{loadError}</p>}

      <CountsBar counts={counts} status={status} onStatus={setStatus} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or URL…"
            className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm"
          />
        </div>
        <TypeToggle type={type} onType={setType} />
        <ColumnMenu columns={hideable} />
      </div>

      {!loaded ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : allRows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
          No Share Links yet. Upload a Video or create a Folder to get one.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full border-collapse text-left">
            <thead className="border-b border-border bg-card">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={table.getVisibleLeafColumns().length}
                    className="px-3 py-10 text-center text-sm text-muted-foreground"
                  >
                    No links match these filters.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={cn(
                      'border-b border-border/60 last:border-0 transition-colors hover:bg-accent/10',
                      row.original.kind === 'folder' && 'bg-card/40',
                      row.getIsSelected() && 'bg-primary/5',
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {selectionCount > 0 && (
        <BulkBar
          count={selectionCount}
          busy={busy}
          onDisable={() => void bulkSetDisabled(true)}
          onReenable={() => void bulkSetDisabled(false)}
          onDelete={() => setBulkDelete(true)}
          onClear={() => setRowSelection({})}
        />
      )}

      {/* Dialogs */}
      {folderDisable && (
        <FolderDisableDialog
          folder={folderDisable}
          busy={busy}
          onCancel={() => setFolderDisable(null)}
          onConfirm={async (cascade) => {
            const ok = await run(
              () => setFolderDisabled(folderDisable.slug, true, cascade),
              cascade ? 'Gallery and its videos disabled' : 'Gallery link disabled',
              'Could not disable the gallery link',
            );
            if (ok) setFolderDisable(null);
          }}
        />
      )}

      {rowDelete && (
        <RowDeleteDialog
          row={rowDelete}
          busy={busy}
          onCancel={() => setRowDelete(null)}
          onDeleteVideo={async () => {
            const ok = await run(
              () => deleteVideo(rowDelete.slug),
              'Video deleted',
              'Could not delete the Video',
            );
            if (ok) setRowDelete(null);
          }}
          onDeleteFolder={async (mode) => {
            const ok = await run(
              () => deleteFolder(rowDelete.slug, mode),
              mode === 'delete'
                ? 'Folder and its videos deleted'
                : 'Folder deleted · videos moved to the Library root',
              'Could not delete the Folder',
            );
            if (ok) setRowDelete(null);
          }}
        />
      )}

      {bulkDelete && (
        <BulkDeleteDialog
          folderCount={bulkDeleteTargets.folders.length}
          videoCount={bulkDeleteTargets.videos.length}
          busy={busy}
          onCancel={() => setBulkDelete(false)}
          onConfirm={() => void confirmBulkDelete()}
        />
      )}
    </div>
  );
}

// --- Presentational pieces -------------------------------------------------

function StatusBadge({ row }: { row: { expired: boolean; disabled: boolean } }) {
  const s = statusOf(row);
  const style =
    s === 'expired'
      ? 'bg-destructive/15 text-destructive'
      : s === 'disabled'
        ? 'bg-muted-foreground/15 text-muted-foreground'
        : 'bg-ok/15 text-ok';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        style,
      )}
    >
      {s}
    </span>
  );
}

function RowActions(props: {
  row: LinkRow;
  busy: boolean;
  onCopy: () => void;
  onToggleDisabled: () => void;
  onDelete: () => void;
}) {
  const { row } = props;
  return (
    <div className="flex items-center justify-end gap-0.5">
      <IconButton label="Copy link" onClick={props.onCopy} disabled={props.busy}>
        <Copy className="size-4" />
      </IconButton>
      <IconButton label="Open link" onClick={() => openShareLink(row.url)} disabled={props.busy}>
        <ExternalLink className="size-4" />
      </IconButton>
      <IconButton
        label={row.disabled ? 'Re-enable link' : 'Disable link'}
        onClick={props.onToggleDisabled}
        disabled={props.busy}
      >
        {row.disabled ? (
          <Power className="size-4 text-ok" />
        ) : (
          <PowerOff className="size-4" />
        )}
      </IconButton>
      <IconButton label="Delete" onClick={props.onDelete} disabled={props.busy} danger>
        <Trash2 className="size-4" />
      </IconButton>
    </div>
  );
}

function IconButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
      className={cn(
        'flex size-8 items-center justify-center rounded-md bg-transparent p-0 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
        props.danger && 'hover:text-destructive',
      )}
    >
      {props.children}
    </button>
  );
}

function CountsBar(props: {
  counts: { total: number; active: number; disabled: number; expired: number; protected: number };
  status: StatusFilter;
  onStatus: (s: StatusFilter) => void;
}) {
  const { counts } = props;
  const chip = (key: StatusFilter, label: string, n: number) => {
    const active = props.status === key;
    return (
      <button
        type="button"
        onClick={() => props.onStatus(active ? null : key)}
        aria-pressed={active}
        className={cn(
          'flex items-baseline gap-1.5 rounded-lg border px-3 py-2 text-left transition-colors',
          active
            ? 'border-primary bg-primary/10 text-foreground'
            : 'border-border bg-card hover:bg-accent/20',
        )}
      >
        <span className="text-lg font-semibold tabular-nums">{n}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </button>
    );
  };
  return (
    <div className="flex flex-wrap gap-2">
      {chip(null, 'total', counts.total)}
      {chip('active', 'active', counts.active)}
      {chip('disabled', 'disabled', counts.disabled)}
      {chip('expired', 'expired', counts.expired)}
      {chip('protected', 'protected', counts.protected)}
    </div>
  );
}

function TypeToggle(props: { type: TypeFilter; onType: (t: TypeFilter) => void }) {
  const opt = (value: TypeFilter, label: string) => (
    <button
      type="button"
      onClick={() => props.onType(value)}
      aria-pressed={props.type === value}
      className={cn(
        'h-9 px-3 text-xs font-medium transition-colors',
        props.type === value
          ? 'bg-accent text-accent-foreground'
          : 'bg-background text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex overflow-hidden rounded-md border border-border">
      {opt('all', 'All')}
      {opt('videos', 'Videos')}
      {opt('folders', 'Folders')}
    </div>
  );
}

/** Column-visibility menu — a native disclosure so no popover library is needed. */
function ColumnMenu({ columns }: { columns: ReturnType<ReturnType<typeof useReactTable<LinkRow>>['getAllLeafColumns']> }) {
  const label = (id: string): string => COLUMN_LABELS[id] ?? id;
  return (
    <details className="relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Columns3 className="size-4" />
        Columns
      </summary>
      <div className="absolute right-0 z-20 mt-1 flex w-44 flex-col gap-0.5 rounded-md border border-border bg-card p-1.5 shadow-lg">
        {columns.map((col) => (
          <label
            key={col.id}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/40"
          >
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={col.getIsVisible()}
              onChange={col.getToggleVisibilityHandler()}
            />
            {label(col.id)}
          </label>
        ))}
      </div>
    </details>
  );
}

const COLUMN_LABELS: Record<string, string> = {
  url: 'URL',
  status: 'Status',
  name: 'Name',
  protected: 'Protected',
  expiry: 'Expiry',
  lifecycle: 'Lifecycle',
  folderPath: 'Folder',
  created: 'Created',
};

function BulkBar(props: {
  count: number;
  busy: boolean;
  onDisable: () => void;
  onReenable: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
      <span className="text-sm">
        <strong className="tabular-nums">{props.count}</strong> selected
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={props.onDisable} disabled={props.busy}>
          <PowerOff className="size-4" />
          Disable
        </Button>
        <Button variant="outline" size="sm" onClick={props.onReenable} disabled={props.busy}>
          <Power className="size-4" />
          Re-enable
        </Button>
        <Button variant="destructive" size="sm" onClick={props.onDelete} disabled={props.busy}>
          <Trash2 className="size-4" />
          Delete
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onClear} disabled={props.busy}>
          Clear
        </Button>
      </div>
    </div>
  );
}
