# videocastle

A self-hostable app for private, straightforward video sharing: an Operator
uploads a Video, it is transcoded to streamable HLS, and a Share Link is handed
out to Viewers. The media stays on the Operator's own server; access is gated
only by an unguessable link (optionally narrowed by a password and/or expiry).

> **Status:** v1 feature-complete. An Operator can upload Videos (streamed to
> disk, transcoded to HLS in the background), organize them into Folders, and
> share either a single Video (`/v/<slug>`) or a whole Folder as a tiled gallery
> (`/f/<slug>`) — each optionally narrowed by a password and/or an expiry, with a
> protected Folder unlocking its Videos in one step. Viewers watch in the browser
> with no account. Uploads respect a configurable size cap, public endpoints are
> rate-limited, and a forgotten Operator password can be reset from the CLI. It
> ships as a single Docker container behind the Operator's own reverse proxy.

## Stack

A TypeScript monolith (see `docs/adr/`): a [Fastify](https://fastify.dev) server
serves both the JSON API and a built [Vite](https://vite.dev)/React SPA.
Metadata lives in SQLite (Node's built-in `node:sqlite`) through a
[Drizzle](https://orm.drizzle.team) query layer; media lives on the local
filesystem under `DATA_DIR`. It ships as a single Docker container behind the
Operator's own TLS-terminating reverse proxy.

## Develop

Requires Node.js 24+ (for the built-in `node:sqlite` module) and `ffmpeg` on
your PATH (the transcoder shells out to `ffmpeg`/`ffprobe`; without them uploads
succeed but every transcode lands in Failed). The flake dev shell provides Node
24, ffmpeg, and `process-compose`:

```sh
nix develop          # enter the dev shell (or use direnv — see below)
npm install
process-compose up   # runs API (:8080) + SPA (:5173) together; q / Ctrl-C stops both
```

`process-compose up` supervises both dev servers as one group, so quitting it
tears everything down — no servers left running on stray ports. (process-compose's
own UI is at http://localhost:8088; the dev shell moves it there so it doesn't
clash with the app's :8080.) To run them individually instead:

```sh
npm run dev:server   # API on http://localhost:8080
npm run dev:web      # SPA on http://localhost:5173 (proxies /api to :8080)
```

If you use [direnv](https://direnv.net) with `nix-direnv`, the committed
`.envrc` (`use flake`) auto-loads the dev shell whenever you `cd` in — run
`direnv allow` once. That keeps ffmpeg on PATH in every terminal, so the server
never starts without it.

Then open http://localhost:5173 and complete first-run setup.

```sh
npm test             # run the test suite (in-process API tests)
npm run typecheck    # type-check without emitting
npm run build        # build the SPA into web/dist
npm run db:generate  # regenerate migration SQL after editing src/db/schema.ts
```

## Deploy

videocastle ships as a single container. With Docker Compose:

```sh
docker compose up --build -d
```

It listens on **plain HTTP** at `http://localhost:8080` (map the port to your
host as you like). All state — media, the SQLite database, and the
auto-generated session secret — lives under `DATA_DIR` (`/data` in the image)
and persists in the `videocastle-data` volume across restarts and image
upgrades. Configure everything via environment variables (see the table below
and `.env.example`).

### Behind your reverse proxy (TLS)

videocastle **does not terminate TLS**. Run it behind your own TLS-terminating
reverse proxy (nginx, Caddy, Traefik, …) and forward to the container over HTTP.
Your proxy should:

- terminate HTTPS and proxy to `http://<host>:8080`;
- set `X-Forwarded-For` (and `X-Forwarded-Proto`) — videocastle trusts these, so
  per-IP rate limiting sees the real client IP rather than the proxy's;
- allow large request bodies (raise the proxy's own upload cap to at least your
  `MAX_UPLOAD_BYTES`, e.g. nginx `client_max_body_size`).

Set `COOKIE_SECURE=true` so the Operator's session cookie is marked `Secure`.
A sketch with Caddy:

```
videos.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

### Reset a forgotten Operator password

There is no email/SMTP recovery. Reset the single Operator credential directly
against the running container:

```sh
docker compose exec videocastle npm run start -- reset-password <username> '<new password>'
```

To keep the new password out of the process list, omit it and pass
`VIDEOCASTLE_NEW_PASSWORD` in the environment instead. The old password stops
working immediately; no restart is needed.

### Check that the reported storage figures are still true

videocastle records what each Video occupies as it writes it, so showing usage
never costs a walk of the media directory. That means the figures can drift — a
crash between writing media and recording it, a restore from a backup taken at a
different moment, a file removed by hand. `storage-reconcile` compares what is
recorded against what is on disk:

```sh
docker compose exec videocastle npm run start -- storage-reconcile
```

It reports only and writes nothing. Add `--apply` to write the measured sizes
back. It exits non-zero whenever it finds anything, so it works as a cron health
check with no output parsing:

```
0  everything agrees
1  drift, orphaned media, or a Video whose media is gone
2  bad usage
```

**It never deletes media, with or without `--apply`** (ADR-0011). Media
directories with no Video behind them are reported with their size and the
command to remove them, and left alone — a tool that deletes directories on the
strength of its own reading of the database would turn a database restore into
permanent data loss. Removing them is your call.

### A note on download deterrence

videocastle makes casual saving harder — segmented HLS (never a single grabbable
file), no download control, a disabled right-click menu over the player — but
this is **deterrence, not protection**. Anyone who can play a Video can capture
it (screen recording at minimum), and the HLS segments are served to the
browser. Do not treat a Share Link, a password, or an expiry as DRM; share
accordingly (see ADR-0003).

## Configuration

| Variable                  | Default           | Purpose                                                              |
| ------------------------- | ----------------- | -------------------------------------------------------------------- |
| `HOST`                    | `0.0.0.0`         | Listen address.                                                      |
| `PORT`                    | `8080`            | Listen port.                                                         |
| `DATA_DIR`                | `./data`          | Root for SQLite and media; mount a volume here in production.        |
| `MEDIA_DIR`               | `$DATA_DIR/media` | Where Sources, Renditions, and Posters are written.                  |
| `MAX_UPLOAD_BYTES`        | `2147483648`      | Largest accepted upload; accepts `2GiB` / `500MB` or bare bytes.     |
| `FFMPEG_PATH`             | `ffmpeg`          | ffmpeg binary used for transcoding.                                  |
| `FFPROBE_PATH`            | `ffprobe`         | ffprobe binary used for probing Sources.                             |
| `TRANSCODE_CONCURRENCY`   | `2`               | Videos transcoded in parallel. Lower it to share the host.           |
| `FFMPEG_THREADS`          | _(ffmpeg's own)_  | `-threads` per ffmpeg invocation; caps CPU per transcode.            |
| `SESSION_SECRET`          | _(auto)_          | Session-signing secret; generated and persisted on first run.        |
| `COOKIE_SECURE`           | `false`           | Set `true` when a reverse proxy terminates TLS.                      |
| `RATE_LIMIT_WINDOW_MS`    | `60000`           | Per-IP rate-limit window, in milliseconds.                           |
| `RATE_LIMIT_MAX`          | `600`             | Max public viewer requests per IP per window (general flood guard).  |
| `RATE_LIMIT_PASSWORD_MAX` | `10`              | Max password attempts per IP per window (Video + Folder unlock).     |

Transcoding shells out to `ffmpeg` (bundled in the Docker image). For local
`npm run dev:server`, install `ffmpeg` on your PATH.

### Sharing the host with other services

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

## License

AGPL-3.0-only (see ADR-0005).
