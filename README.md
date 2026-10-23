# videocastle

A self-hostable app for private, straightforward video sharing: an Operator
uploads a Video, it is transcoded to streamable HLS, and a Share Link is handed
out to Viewers. The media stays on the Operator's own server; access is gated
only by an unguessable link (optionally narrowed by a password and/or expiry).

> **Status:** early. This is the walking skeleton — a running server, the single
> Operator credential, first-run setup, and sign-in. Uploads, transcoding,
> sharing, and Folders arrive in later milestones.

## Stack

A TypeScript monolith (see `docs/adr/`): a [Fastify](https://fastify.dev) server
serves both the JSON API and a built [Vite](https://vite.dev)/React SPA.
Metadata lives in SQLite (Node's built-in `node:sqlite`) through a
[Drizzle](https://orm.drizzle.team) query layer; media will live on the local
filesystem. It ships as a single Docker container behind the Operator's own
TLS-terminating reverse proxy.

## Develop

Requires Node.js 24+ (for the built-in `node:sqlite` module).

```sh
npm install
npm run dev:server   # API on http://localhost:8080
npm run dev:web      # SPA on http://localhost:5173 (proxies /api to :8080)
```

Then open http://localhost:5173 and complete first-run setup.

```sh
npm test             # run the test suite (in-process API tests)
npm run typecheck    # type-check without emitting
npm run build        # build the SPA into web/dist
npm run db:generate  # regenerate migration SQL after editing src/db/schema.ts
```

## Run with Docker

```sh
docker compose up --build
```

videocastle listens on `http://localhost:8080`. Data (media, SQLite, and the
auto-generated session secret) persists in the `videocastle-data` volume across
restarts. Configure via environment variables — see `.env.example`.

## Configuration

| Variable         | Default   | Purpose                                                        |
| ---------------- | --------- | -------------------------------------------------------------- |
| `HOST`           | `0.0.0.0` | Listen address.                                                |
| `PORT`           | `8080`    | Listen port.                                                   |
| `DATA_DIR`       | `./data`  | Root for SQLite and media; mount a volume here in production.  |
| `SESSION_SECRET` | _(auto)_  | Session-signing secret; generated and persisted on first run.  |
| `COOKIE_SECURE`  | `false`   | Set `true` when a reverse proxy terminates TLS.                |

## License

AGPL-3.0-only (see ADR-0005).
