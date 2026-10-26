# Configuration

Everything is configured through environment variables, read once at startup.
A fresh install works with none of them set — the defaults below are the
install. `.env.example` is the same list in copy-and-adjust form.

These are **Host Configuration**: the settings only the person running the
server decides. They are never editable from the Dashboard, and the Dashboard's
read-only **Settings → Server** view states every value in effect and whether it
came from the environment or a built-in default.

| Variable                      | Default           | Purpose                                                              |
| ----------------------------- | ----------------- | -------------------------------------------------------------------- |
| `HOST`                        | `0.0.0.0`         | Listen address.                                                      |
| `PORT`                        | `8080`            | Listen port.                                                         |
| `DATA_DIR`                    | `./data`          | Root for SQLite and media; mount a volume here in production.        |
| `MEDIA_DIR`                   | `$DATA_DIR/media` | Where Sources, Renditions, and Posters are written.                  |
| `MAX_UPLOAD_BYTES`            | `2147483648`      | Largest accepted upload; accepts `2GiB` / `500MB` or bare bytes.     |
| `FFMPEG_PATH`                 | `ffmpeg`          | ffmpeg binary used for transcoding.                                  |
| `FFPROBE_PATH`                | `ffprobe`         | ffprobe binary used for probing Sources.                             |
| `STORAGE_QUOTA_BYTES`         | _(unlimited)_     | Ceiling on total media bytes. Refuses writes; never deletes.         |
| `MIN_FREE_DISK_BYTES`         | `1GiB`            | Free space that must remain on the media filesystem.                 |
| `QUOTA_WARN_PERCENT`          | `80`              | Where the Dashboard's storage warning band starts.                   |
| `TRANSCODE_CONCURRENCY`       | `2`               | Videos transcoded in parallel. Lower it to share the host.           |
| `FFMPEG_THREADS`              | _(ffmpeg's own)_  | `-threads` per ffmpeg invocation; caps CPU per transcode.            |
| `KEEP_SOURCE_AFTER_TRANSCODE` | `true`            | Keep each Video's original. Off halves what new Videos cost.         |
| `SESSION_SECRET`              | _(auto)_          | Session-signing secret; generated and persisted on first run.        |
| `COOKIE_SECURE`               | `false`           | Set `true` when a reverse proxy terminates TLS.                      |
| `RATE_LIMIT_WINDOW_MS`        | `60000`           | Per-IP rate-limit window, in milliseconds.                           |
| `RATE_LIMIT_MAX`              | `600`             | Max public viewer requests per IP per window (general flood guard).  |
| `RATE_LIMIT_PASSWORD_MAX`     | `10`              | Max password attempts per IP per window (Video + Folder unlock).     |

Transcoding shells out to `ffmpeg` (bundled in the Docker image). For local
`npm run dev:server`, install `ffmpeg` on your PATH.

## Capping how much disk videocastle uses

If the box also runs other services, cap what this instance may consume:

```
STORAGE_QUOTA_BYTES=200GiB
MIN_FREE_DISK_BYTES=5GiB
```

`STORAGE_QUOTA_BYTES` is a ceiling on the total bytes of media (Sources,
Renditions, Posters) and is **unlimited by default** — a fresh install should
work with no env file. `MIN_FREE_DISK_BYTES` is independent of it and is **on by
default at 1 GiB**, because a filesystem with no room left can wedge or corrupt
SQLite; that is a correctness risk rather than a capacity preference.

At either ceiling, videocastle **refuses new writes** — uploads and transcode
retries — with **507 Insufficient Storage** and a stable reason code
(`quota_exceeded` or `disk_floor_reached`) carrying the real figures. It is
checked both from `Content-Length` and again on the bytes actually arriving, so
a client that omits or understates its length is still stopped, and a refused
upload leaves no partial Source behind.

**Nothing is ever deleted to make room** ([ADR-0011](adr/0011-storage-pressure-never-deletes-operator-media.md)).
There is no eviction, no pruning, no "oldest first". **Playback is never gated
either**: a full disk costs you the ability to add Videos, never a Viewer the
ability to watch one you already shared a link to.

The Dashboard shows all of this: a live meter in the sidebar, a **Storage**
section breaking usage down with your Videos listed largest-first, and the
read-only **Settings → Server** view. From `QUOTA_WARN_PERCENT` (80% by default)
upward the meter turns amber and a standing banner appears; past the ceiling
both turn red. 80% is a guess about someone else's disk — on a 20 GB quota it
fires with 4 GB left, on a 2 TB quota with 400 GB left — so it is configurable.

Two consequences worth knowing. Lowering the Quota below what is already stored
is a legal state — nothing is removed, writes refuse, and the reported usage is
the truth rather than a figure clamped to the ceiling; you free space by deleting
Videos you choose. And a Retry that starts with room may finish slightly over,
because the size of a Rendition is not knowable before it is encoded.

## Giving up the originals to halve what a Video costs

Each Video keeps the file you uploaded — its **Source** — alongside the
streamable Rendition, which roughly doubles its cost on disk. If you have the
originals elsewhere and don't need videocastle to hold them, turn that off:

```
KEEP_SOURCE_AFTER_TRANSCODE=false
```

Only the exact string `false` turns it off, so a typo errs towards holding on to
your originals rather than destroying them.

**This is forward-only.** It governs Videos transcoded from now on and never
touches a Source already on disk — a setting that reads as "stop keeping these
from now on" must not mean "destroy the ones I kept"
([ADR-0010](adr/0010-optional-source-discard-is-forward-only.md)). To reclaim
the Sources you already hold, ask for it explicitly: see
[`reclaim-sources`](operating.md#reclaim-the-originals-you-already-hold).

## Sharing the host with other services

Transcoding is the part of videocastle that a VPS's other tenants notice. Two
knobs bound it, and you generally want both — `TRANSCODE_CONCURRENCY` alone caps
how many transcodes run, not what one transcode costs, and ffmpeg will happily
use every core it can see:

```
TRANSCODE_CONCURRENCY=1
FFMPEG_THREADS=2
```

Queued uploads still complete; they just wait their turn, which is usually the
right trade on a box that is also serving something else. CPU priority itself is
better left to the platform (`docker --cpus`, systemd's `CPUQuota`, `nice`) than
configured here.
