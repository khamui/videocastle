import { useState } from 'react';
import { FolderPlus } from 'lucide-react';

import { createFolder } from '@/api';
import { useFeedback } from '@/components/feedback/use-feedback';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/** `+ New folder` header button → a small modal with a name field. */
export function NewFolderDialog(props: { onCreated: () => void }) {
  const { notify, reportError } = useFeedback();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    if (name.trim().length === 0) return;
    setBusy(true);
    try {
      await createFolder(name.trim());
      setOpen(false);
      setName('');
      props.onCreated();
      notify('Folder created');
    } catch (err) {
      reportError(err, { title: 'Could not create folder' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setName('');
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <FolderPlus className="size-4" />
          New folder
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
        </DialogHeader>
        <label className="flex flex-col gap-1.5 text-sm">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
            placeholder="Folder name"
            className="rounded-md border border-input bg-background px-3 py-2 text-foreground focus-visible:border-ring focus-visible:outline-none"
          />
        </label>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={() => void create()}
            disabled={busy || name.trim().length === 0}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
