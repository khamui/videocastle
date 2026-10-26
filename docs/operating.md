# Operating an instance

Running videocastle in production: putting it behind your proxy, recovering
access, and keeping its storage figures honest. For the environment variables
themselves see [configuration.md](configuration.md).

## Deploy

videocastle ships as a single container. With Docker Compose:

```sh
docker compose up --build -d
```

It listens on **plain HTTP** at `http://localhost:8080`. All state — media, the
SQLite database, and the auto-generated session secret — lives under `DATA_DIR`
(`/data` in the image) and persists in the `videocastle-data` volume across
restarts and image upgrades.

### When 8080 is already taken

A box that already runs something on 8080 fails at `docker compose up` with a
message that reads like a crash but is Docker refusing to bind the host port:

```
failed to bind port 0.0.0.0:8080/tcp: Error starting userland proxy:
listen tcp4 0.0.0.0:8080: bind: address already in use
```

The container never started, so nothing is wrong with your install. Find what
holds the port:

```sh
sudo ss -ltnp 'sport = :8080'    # or: sudo lsof -i :8080
docker ps --filter publish=8080  # in case it's an older container of your own
```

Then either stop that, or move videocastle's **host** port — the container keeps
listening on 8080 internally, so nothing else changes:

```sh
echo 'HOST_PORT=8090' >> .env
docker compose up -d
```

Point your reverse proxy at the new port (`reverse_proxy 127.0.0.1:8090`).

## Behind your reverse proxy (TLS)

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

## Reset a forgotten Operator password

There is no email/SMTP recovery. Reset the single Operator credential directly
against the running container:

```sh
docker compose exec videocastle npm run start -- reset-password <username> '<new password>'
```

To keep the new password out of the process list, omit it and pass
`VIDEOCASTLE_NEW_PASSWORD` in the environment instead. The old password stops
working immediately; no restart is needed.

## Check that the reported storage figures are still true

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

**It never deletes media, with or without `--apply`**
([ADR-0011](adr/0011-storage-pressure-never-deletes-operator-media.md)). Media
directories with no Video behind them are reported with their size and the
command to remove them, and left alone — a tool that deletes directories on the
strength of its own reading of the database would turn a database restore into
permanent data loss. Removing them is your call.

This is also the one-off step for an instance that has Videos predating storage
accounting: their recorded sizes are zero, so run `storage-reconcile --apply`
once after upgrading and the figures are correct from then on. There is
deliberately no automatic version of this — re-measuring the whole media
directory is something you ask for, not something a boot does to you.

## Reclaim the originals you already hold

Setting `KEEP_SOURCE_AFTER_TRANSCODE=false` is forward-only: it stops *new*
Videos keeping their Source and never touches one already on disk
([ADR-0010](adr/0010-optional-source-discard-is-forward-only.md)). To discard
the ones you already hold, ask for it explicitly:

```sh
docker compose exec videocastle npm run start -- reclaim-sources
```

Dry-run by default; add `--apply` to discard. It only ever touches **Ready**
Videos — a Failed Video's Source is its only route back from a failed
transcode, so it is skipped and reported. A reclaimed Video keeps playing from
the Rendition it already has, but **can never be re-transcoded**, and the
Dashboard shows its Retry as unavailable with the reason rather than offering
it and then failing.

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

### Regenerate the README demo GIF

`scripts/demo.ts` drives a real instance through the whole arc — upload,
transcode, Share Link, Watch Page — in a scripted browser and writes
`docs/images/demo.gif`. It needs the dev shell (for ffmpeg) and a Chromium-based
browser:

```sh
nix develop
npm run demo:gif
```

The clip it uploads is generated by ffmpeg at run time; no video file is
committed to the repo. Playwright's own bundled Chromium does not run on NixOS,
so the script falls back to a system `google-chrome-stable`; override the choice
with `DEMO_BROWSER=/path/to/chrome`.
