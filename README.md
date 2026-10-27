<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo.svg">
    <img alt="videocastle" src="docs/images/logo-light.svg" width="340">
  </picture>
</p>

<p align="center">
  <strong>Send someone a video from your own server. One link, no account, no upload to anybody else's cloud.</strong>
</p>

![Uploading a Video in the Dashboard, copying its Share Link, and watching it on the Watch Page](docs/images/demo.gif)

Instead of making it public on YouTube, dropping a file in Drive that the other
person has to download, or sending a transfer link that expires before they open
it — you run videocastle on a box you control and hand out a link.

- **The media never leaves your server.** No third party holds your files, sees
  who watched, or changes the terms later.
- **Viewers need no account.** They open a link and the video plays. Nothing to
  sign up for, nothing to install.
- **Real streaming, not a download.** Every upload is transcoded to HLS and
  played in the browser — it starts immediately and seeks properly.
- **One container, your proxy.** A single image, a single volume, behind the
  reverse proxy you already run.

Narrow a link further with a password, an expiry, or both. Share a single Video
(`/v/<slug>`) or a whole Folder as a tiled gallery (`/f/<slug>`).

## Getting started

You need Docker and a few minutes. There's no published image yet, so you build
it from the clone:

```sh
git clone https://github.com/khamui/videocastle.git
cd videocastle
docker compose up --build -d
```

Open <http://localhost:8080>, complete first-run setup — you pick the single
Operator username and password — and upload something. No configuration is
needed to try it; every setting has a working default.

For a real deployment you'll want it behind your own TLS-terminating proxy: see
[docs/operating.md](docs/operating.md).

## What it isn't

Stated up front, because these are deliberate and won't change soon:

- **Not DRM.** Segmented HLS, no download control, and a disabled right-click
  menu make casual saving harder. That's deterrence. Anyone who can play a Video
  can capture it, and the segments are served to the browser — so don't treat a
  Share Link as protection ([ADR-0003](docs/adr/0003-deterrence-over-drm.md)).
- **Not multi-user.** One Operator per instance. No teams, no roles, no
  per-Viewer accounts or permissions.
- **Not a TLS terminator.** It speaks plain HTTP and expects your reverse proxy
  to handle certificates.
- **No email, ever.** No SMTP to configure, and so no password-reset mail — a
  forgotten Operator password is reset with a CLI command on the server.

## Project status

**v0.1 — the v1 feature set is complete and tested; not yet released.** Expect
to build from source and read the code.

- **182 tests passing across 17 suites** — in-process API and integration tests
  covering upload, transcode lifecycle, Folders, sharing, passwords, expiry,
  rate limiting, storage accounting, and the CLI commands.
- 10 further tests drive real `ffmpeg`, and run only where it's installed.
- **No browser/DOM coverage yet** — UI regressions aren't locked down
  ([#64](https://github.com/khamui/videocastle/issues/64)).
- **No CI yet.** Tests run locally with `npm test`.

## Planned, not promised

- Published container image on GHCR, so trying it stops requiring a build
  ([#68](https://github.com/khamui/videocastle/issues/68))
- A documentation website ([#69](https://github.com/khamui/videocastle/issues/69))
- Retention / auto-expiry of Videos ([#58](https://github.com/khamui/videocastle/issues/58))
- Egress / bandwidth accounting and a cap ([#57](https://github.com/khamui/videocastle/issues/57))
- UI test coverage ([#64](https://github.com/khamui/videocastle/issues/64))

## Documentation

- [Operating an instance](docs/operating.md) — deploy, reverse proxy, password
  reset, storage reconciliation
- [Configuration](docs/configuration.md) — every environment variable, quotas,
  and sharing the host with other services
- [Glossary](GLOSSARY.md) — the words this project uses and means precisely
- [Decision records](docs/adr/) — why it's built the way it is

## Develop

A TypeScript monolith: a [Fastify](https://fastify.dev) server serves both the
JSON API and a built [Vite](https://vite.dev)/React SPA. Metadata lives in SQLite
(Node's built-in `node:sqlite`) through a [Drizzle](https://orm.drizzle.team)
query layer; media lives on the local filesystem
([ADR-0004](docs/adr/0004-stack-and-deploy-shape.md)).

Node 24+ and `ffmpeg` on your PATH; the flake dev shell provides both.

```sh
nix develop
npm install
process-compose up   # API (:8080) + SPA (:5173) together
```

Full developer setup, test commands, and how to regenerate the demo GIF above:
[docs/operating.md#develop](docs/operating.md#develop).

## License

AGPL-3.0-only ([ADR-0005](docs/adr/0005-agpl-license.md)) — see
[LICENSE](LICENSE).
