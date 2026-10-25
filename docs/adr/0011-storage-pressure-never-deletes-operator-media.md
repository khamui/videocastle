# Storage pressure refuses writes; it never deletes Operator media

When the instance hits its Quota, or the free space on the host drops below the
configured floor, videocastle **refuses new writes** — uploads and transcode
retries — with a technical error naming which ceiling was hit (ADR-0007). It
never deletes, evicts, prunes, archives or downgrades anything already stored.
There is no LRU eviction, no oldest-first sweep, no "make room automatically".
Playback of what is already there is never gated: a full disk degrades the
Operator's ability to add Videos, never the Viewer's ability to watch the ones
they were given links to.

The Operator owns the server and the media on it (ADR-0001). Software that
deletes their originals to satisfy a number in its own configuration has
substituted its judgement for theirs about which of their Videos matter, and
unlike a refused upload — which the Operator notices immediately and can retry
— a deletion is silent and permanent. Refusing a write is recoverable by
definition; the Operator frees space by deleting Videos they chose, or raises
the ceiling.

Two consequences follow. Lowering the Quota below current usage is a **legal,
visible state**: nothing is removed, writes refuse, and the Dashboard reports
the real figure (over 100%) rather than clamping the meter to full and implying
it just fits. And the storage-reconciliation tool, which compares the recorded
byte totals against what is actually on disk, **reports** media directories it
finds no Video for but never removes them — a tool that deletes directories on
the strength of its own reading of the database turns a restore from backup into
permanent data loss.

The one way a Source is ever discarded is the Operator asking for it explicitly
(ADR-0010).
