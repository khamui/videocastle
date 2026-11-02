import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';

import type { FolderSummary } from '@/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** One picked file and the title the Operator has given it (blank = "Unnamed video"). */
interface Entry {
  file: File;
  title: string;
}

/** A file's name without its extension — the muted placeholder for its title. */
function stem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * `+ Upload` header button → modal with a drag/click dropzone that takes up to
 * `maxBatch` files at once (GLOSSARY: Upload batch). Submitting hands the whole
 * batch to the Library (`onStart`) and closes immediately: the files upload one
 * at a time with real progress on optimistic cards, so the Operator can keep
 * working. A title is optional per file; a description is offered only for a
 * single file (it's editable later per-Video in the drawer).
 */
export function UploadDialog(props: {
  disabled?: boolean;
  folders: FolderSummary[];
  /** Most files allowed in one batch (Host Configuration: MAX_UPLOAD_BATCH). */
  maxBatch: number;
  onStart: (
    items: {
      title: string;
      description: string;
      file: File;
      folderSlug: string | null;
    }[],
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [description, setDescription] = useState('');
  // 'root' is the sentinel for the Library root (no Folder).
  const [folderValue, setFolderValue] = useState('root');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setEntries([]);
    setDescription('');
    setFolderValue('root');
    setDragOver(false);
    if (inputRef.current) inputRef.current.value = '';
  }

  /** Appends dropped/chosen files, stopping at the batch cap. */
  function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setEntries((prev) => {
      const room = props.maxBatch - prev.length;
      const next = Array.from(files)
        .slice(0, Math.max(0, room))
        .map((file) => ({ file, title: '' }));
      return [...prev, ...next];
    });
  }

  function submit() {
    // Only a file is required; a blank title becomes "Unnamed video" server-side.
    if (entries.length === 0) return;
    const single = entries.length === 1;
    props.onStart(
      entries.map((entry) => ({
        title: entry.title.trim(),
        // A description is only collected for a lone file; a batch defers it.
        description: single ? description : '',
        file: entry.file,
        folderSlug: folderValue === 'root' ? null : folderValue,
      })),
    );
    setOpen(false);
    reset();
  }

  const atCap = entries.length >= props.maxBatch;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={props.disabled}>
          <Upload className="size-4" />
          Upload
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload videos</DialogTitle>
          <DialogDescription>
            Pick up to {props.maxBatch}. They upload one at a time and transcode
            to HLS in the background — each Share Link works right away.
          </DialogDescription>
        </DialogHeader>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
          disabled={atCap}
          className={cn(
            'flex min-h-28 w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border bg-background/40 p-6 text-center text-sm transition-colors hover:border-ring disabled:cursor-not-allowed disabled:opacity-60',
            dragOver && 'border-ring bg-accent/40',
          )}
        >
          <span className="font-medium">
            {atCap
              ? `Batch is full (${props.maxBatch})`
              : 'Drag videos here, or click to choose'}
          </span>
          <span className="text-xs text-muted-foreground">
            up to {props.maxBatch} files
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="video/*,.mov,.mp4,.m4v"
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />

        {entries.length > 0 && (
          <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto">
            {entries.map((entry, i) => (
              <li
                key={`${entry.file.name}-${i}`}
                className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5"
              >
                <input
                  value={entry.title}
                  onChange={(e) =>
                    setEntries((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
                    )
                  }
                  placeholder={stem(entry.file.name) || 'Unnamed video'}
                  aria-label={`Title for ${entry.file.name}`}
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground focus-visible:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setEntries((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${entry.file.name}`}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {entries.length === 1 && (
          <label className="flex flex-col gap-1.5 text-sm">
            Description <span className="text-muted-foreground">(optional)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-foreground focus-visible:border-ring focus-visible:outline-none"
            />
          </label>
        )}

        <div className="flex flex-col gap-1.5 text-sm">
          Folder <span className="text-muted-foreground">(optional)</span>
          <Select value={folderValue} onValueChange={setFolderValue}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="root">Library (no folder)</SelectItem>
              {props.folders.map((f) => (
                <SelectItem key={f.slug} value={f.slug}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={submit} disabled={props.disabled || entries.length === 0}>
            {entries.length > 1 ? `Start ${entries.length} uploads` : 'Start upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
