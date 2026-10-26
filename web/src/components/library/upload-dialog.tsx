import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';

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
import { cn } from '@/lib/utils';

/**
 * `+ Upload` header button → modal with a drag/click dropzone. Submitting hands
 * the file to the Library (`onStart`) and closes immediately: the upload runs
 * with a real progress bar on an optimistic card, so the Operator can keep
 * working or queue more. Success/failure surface there, not in this dialog.
 */
export function UploadDialog(props: {
  disabled?: boolean;
  onStart: (input: { title: string; description: string; file: File }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setTitle('');
    setDescription('');
    setFile(null);
    setDragOver(false);
    if (inputRef.current) inputRef.current.value = '';
  }

  function submit() {
    if (!file || title.trim().length === 0) return;
    props.onStart({ title: title.trim(), description, file });
    setOpen(false);
    reset();
  }

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
          <DialogTitle>Upload a video</DialogTitle>
          <DialogDescription>
            It uploads with a progress bar, then transcodes to HLS in the
            background — the Share Link works right away.
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
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) setFile(dropped);
          }}
          className={cn(
            'flex min-h-32 w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border bg-background/40 p-6 text-center text-sm transition-colors hover:border-ring',
            dragOver && 'border-ring bg-accent/40',
          )}
        >
          {file ? (
            <span className="font-medium">{file.name}</span>
          ) : (
            <>
              <span className="font-medium">
                Drag a video here, or click to choose
              </span>
              <span className="text-xs text-muted-foreground">up to 2 GB</span>
            </>
          )}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="video/*,.mov,.mp4,.m4v"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />

        <label className="flex flex-col gap-1.5 text-sm">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Video title"
            className="rounded-md border border-input bg-background px-3 py-2 text-foreground focus-visible:border-ring focus-visible:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Description <span className="text-muted-foreground">(optional)</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-foreground focus-visible:border-ring focus-visible:outline-none"
          />
        </label>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={submit}
            disabled={props.disabled || !file || title.trim().length === 0}
          >
            Start upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
