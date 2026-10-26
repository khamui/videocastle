import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';

import { uploadVideo } from '@/api';
import { useFeedback } from '@/components/feedback/use-feedback';
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
 * `+ Upload` header button → modal with a drag/click dropzone. The upload
 * returns immediately and transcodes in the background (unchanged behavior);
 * success toasts, failure uses the persistent error surface (ADR-0009).
 */
export function UploadDialog(props: {
  disabled?: boolean;
  onUploaded: () => void;
}) {
  const { notify, reportError } = useFeedback();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setTitle('');
    setDescription('');
    setFile(null);
    setDragOver(false);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function submit() {
    if (!file || title.trim().length === 0) return;
    setBusy(true);
    try {
      await uploadVideo({ title, description, file });
      props.onUploaded();
      notify('Upload started · transcoding');
    } catch (err) {
      reportError(err, { title: 'Upload failed' });
    } finally {
      // Close on both paths — including failure — so the persistent error card
      // isn't left hidden behind the full-screen dialog on mobile (ADR-0008).
      // `reset()` also clears `busy`.
      setOpen(false);
      reset();
    }
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
            It transcodes to HLS in the background — the Share Link works right
            away.
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
            onClick={() => void submit()}
            disabled={
              props.disabled || busy || !file || title.trim().length === 0
            }
          >
            {busy ? 'Uploading…' : 'Start upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
