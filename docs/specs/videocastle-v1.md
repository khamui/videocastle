# Spec: videocastle v1

> Status: draft spec (PRD). Feeds `/to-tickets docs/specs/videocastle-v1.md`.
> Vocabulary follows `GLOSSARY.md`. Decisions respect `docs/adr/0001`–`0009`.
> Look & feel and operator/viewer flow were validated in the throwaway prototype on branch `prototype/look-and-feel` (Studio Dark direction, "Model 2" drawer-based flow). The UI toolkit (shadcn/ui + Tailwind, ADR-0008) and the feedback split (ADR-0009) are now settled; see **Operator & Viewer UI** under Implementation Decisions.

## Problem Statement

People regularly need to send someone a video privately — a recorded call, an interview, a draft cut, a client deliverable — without handing it to a third-party vendor's cloud (YouTube, Drive, Dropbox, WeTransfer) and without making the recipient create an account or install anything. They want to drop a link into whatever messenger the recipient already uses and have it just play. Today that means either trusting a vendor with private footage, or standing up and babysitting a complicated streaming stack. Neither is acceptable for someone who simply owns a VPS and wants to stay in control of their own files.

## Solution

videocastle is a self-hostable application an **Operator** runs on their own server. The Operator uploads a **Video**; it transcodes to streamable HLS in the background; the Operator gets an unguessable **Share Link** to paste into any messenger. A **Viewer** opens the link and watches in the browser — no account, no login, no install. Videos can be grouped into a **Folder** and shared as one tiled gallery. The media never leaves the Operator's server; privacy is enforced by the unguessable link, optionally narrowed by a password and/or an expiry. The whole thing deploys as a single Docker container behind the Operator's own reverse proxy.

## User Stories

### Operator — setup & access
1. As an Operator, I want to set my own password on first run, so that only I can manage this instance.
2. As an Operator, I want my credential stored hashed on my server (never in a compose file), so that my deploy config can't leak it.
3. As an Operator, I want to sign in and get a session that survives restarts, so that I'm not re-authenticating constantly.
4. As an Operator, I want a way to reset my password from the server if I forget it, so that I'm never locked out of my own instance.
5. As an Operator, I want everything behind my single login, so that there is no public sign-up or second account to manage.

### Operator — uploading & transcoding
6. As an Operator, I want to upload a large video without the request buffering it all in memory, so that big files don't crash the instance.
7. As an Operator, I want the upload to return immediately and transcode in the background, so that I'm not blocked waiting on ffmpeg.
8. As an Operator, I want the Share Link to exist the moment I upload, so that I can send it before transcoding finishes.
9. As an Operator, I want to see a Video's state (Processing / Ready / Failed / Expired), so that I know whether it's watchable.
10. As an Operator, I want to watch transcoding progress, so that I know roughly how long until it's ready.
11. As an Operator, I want a clear Failed state with a retry when ffmpeg errors, so that a transient failure doesn't lose my upload.
12. As an Operator, I want an auto-generated poster frame, so that the Video has a sensible still before playback.
13. As an Operator, I want an operator-configurable maximum upload size, so that I can cap what the instance accepts.
14. As an Operator, I want a clear error and cleanup of the partial file if an upload exceeds the cap or the disk fills, so that failed uploads don't leave junk behind.

### Operator — managing videos
15. As an Operator, I want to give each Video a title (and optional description), so that my Library is legible.
16. As an Operator, I want to see all my Videos and Folders in one Library view, so that I can find things quickly.
17. As an Operator, I want to copy a Video's Share Link in one action, so that pasting it into a messenger is effortless.
18. As an Operator, I want to preview a Video exactly as a Viewer would, so that I can confirm it before sharing.
19. As an Operator, I want to delete a Video, purging its Source and Rendition and killing its link immediately, so that private footage is really gone.
20. As an Operator, I want deletion to be irreversible and clearly warned, so that I don't delete by accident.

### Operator — share link protection
21. As an Operator, I want each Video's link to be unguessable but short, so that it's safe to share yet easy to paste.
22. As an Operator, I want to optionally password-protect a Video, so that even a leaked link needs a secret to open.
23. As an Operator, I want to optionally set an expiry on a Video's link, so that access ends automatically.
24. As an Operator, I want to extend or re-enable an expired link, so that I can re-share something without re-uploading.

### Operator — folders
25. As an Operator, I want to create a Folder, so that I can group related Videos.
26. As an Operator, I want to put a Video in at most one Folder (or leave it at the Library root), so that there's one unambiguous place it lives.
27. As an Operator, I want to move a Video between the Library root and a Folder, so that I can reorganize without re-uploading.
28. As an Operator, I want to share a Folder as a single gallery link, so that a Viewer sees all its Videos at once.
29. As an Operator, I want a Folder to have its own optional password and expiry, so that I can protect the whole gallery.
30. As an Operator, I want to see and browse a Folder's Videos while managing it, so that I can work inside a Folder.
31. As an Operator, I want to delete a Folder and choose whether to also delete its Videos or keep them by moving them to the Library root, so that I don't lose Videos I meant to keep.
32. As an Operator, I never want to share my whole Library at once, so that there's no "everything" link to leak.

### Viewer
33. As a Viewer, I want to open a Share Link and watch in my browser with no account or install, so that sharing is frictionless.
34. As a Viewer, I want playback to adapt to a single HLS Rendition that just works on my device, so that I can watch on mobile or desktop.
35. As a Viewer, I want a password prompt when a Video or Folder is protected, so that I can enter the secret I was given.
36. As a Viewer, I want a Folder link to show a tiled gallery of its Videos, so that I can pick what to watch.
37. As a Viewer, once I've unlocked a protected Folder, I want to play any Video in it without re-entering the password, so that browsing a gallery isn't tedious.
38. As a Viewer opening a Video from within a Folder, I want a way back to the gallery, so that I can keep browsing.
39. As a Viewer, I want a direct Video link to show only that Video and never reveal its Folder siblings, so that a single share can't leak a confidential Folder.
40. As a Viewer, I want a Video that's still processing to tell me it's being prepared, so that I know to come back.
41. As a Viewer, I want expired, deleted, and unknown links to all show the same generic "not available" page, so that the system never reveals whether a given link ever existed.
42. As a Viewer, I don't want an obvious download control, so that casual saving is discouraged (with no pretense that determined capture is prevented).

### Operator — deployment
43. As an Operator, I want to run the whole app as one Docker container via compose, so that deploying is `docker compose up`.
44. As an Operator, I want to terminate TLS at my own reverse proxy, so that videocastle only needs to listen on plain HTTP.
45. As an Operator, I want media and metadata to live on my server with no external services (only ffmpeg), so that I own my data and the deploy stays simple.
46. As an Operator, I want data (media files + SQLite + session secret) to persist across container restarts via a volume, so that nothing is lost on redeploy.

## Implementation Decisions

**Architecture & stack** (ADR-0004, ADR-0001). A TypeScript monolith: a Fastify backend that serves the built Vite/React SPA and the JSON/HTTP API, plus an in-process worker that performs transcoding by shelling out to `ffmpeg`. Metadata in embedded SQLite via a low-magic query layer (Drizzle). Media (Sources, HLS segments, posters) on the local filesystem under a configurable data directory. Ships as a single Docker container deployed with Compose; listens on plain HTTP behind the Operator's own TLS-terminating reverse proxy. Explicit, boring, human-maintainable tooling is a hard constraint (ADR-0001): no framework "magic" that can only be understood with an LLM.

**Operator & Viewer UI** (ADR-0008, ADR-0009; prototype `prototype/look-and-feel`, "Studio Dark / Model 2"). The SPA is built with **shadcn/ui on Tailwind CSS** (Radix primitives, component source vendored into the repo), with the Studio Dark palette as Tailwind theme tokens. The app stays **router-less** (manual `pathname` matching for the public `/v` and `/f` viewer paths only); drawers and open-folder state are transient component state, not URL-addressable. The build is **mobile-first / portrait** — the phone layout is primary and the desktop layout is the enhancement.

- **Operator shell.** A two-pane shell: a persistent left sidebar on desktop (brand lockup; nav *Library / Share links / Storage / Settings*; a storage meter; Sign out) that collapses to a **hamburger off-canvas menu** in portrait. Only *Library* is built in v1; *Share links / Storage / Settings* render honest "not built yet" placeholders, and the **storage meter is a visual placeholder** (no storage-accounting endpoint in v1).
- **Library.** A folder-card grid and a video-card grid (root/loose Videos), each card carrying a status pill (Ready / Processing / Failed / Expired); responsive single-column → grid.
- **Card → drawer (Model 2).** Clicking a Video or Folder card opens a **detail drawer** — a right-anchored drawer on desktop, a **full-screen sheet** in portrait — holding copy-share-link, a password switch, an expiry select, move-to-Folder, and delete. A Folder's drawer lists its Videos to drill into each Video's drawer. **Preview** opens the real Viewer experience (`/v` or `/f`) in a new tab.
- **Upload & new-folder.** Upload is a header **button** that opens a **modal** (full-screen sheet in portrait) with a drag/click dropzone — never an always-expanded form. New-folder is likewise a small modal. Destructive confirms are modal dialogs; deleting a Folder forces the ADR-0006 purge-vs-move-to-root choice.
- **Feedback (ADR-0009).** Success/info → transient bottom toasts; **errors → a persistent, dismissible, copy-pasteable surface** carrying the technical cause and stable `reason` code (ADR-0007), never an auto-dismissing toast. This replaces all native `window.prompt`/`confirm` usage.
- **Viewer surfaces.** The Watch Page and Folder gallery are restyled to Studio Dark/Tailwind as well (same ADR-0002 opacity and ADR-0003 download-deterrence behaviour — presentation only, no behavioural change).

**Entities (logical, not table DDL).**
- **Operator credential**: a single username + hashed password (argon2/bcrypt) per instance; created on first run.
- **Video**: id, title, optional description, Source reference, Rendition reference, poster reference, state, slug, optional password (hashed), optional expiry timestamp, optional owning Folder, created-at, view count.
- **Folder**: id, name, slug, optional password (hashed), optional expiry timestamp, created-at.
- Membership is exclusive: a Video references at most one Folder, else it is at the Library root (ADR-0006).

**Video lifecycle** (state machine validated in the prototype). States and transitions:
```
uploaded ──▶ Processing ──▶ Ready
                   └──────▶ Failed ──(retry)──▶ Processing
Ready ──(expiry passes)──▶ Expired ──(extend / set future expiry)──▶ Ready
any ──(delete)──▶ gone (Source + Rendition purged, link dead)
```
A Share Link exists from `uploaded` onward; it is playable only in `Ready`. (Folders do not transcode; a Folder is Ready unless expired.)

**Share Link model** (ADR-0002, ADR-0006). The shareable unit is a Video or a Folder; the Library is never shareable. Link kinds:
- Video (standalone): `/v/<videoSlug>` — shows only that Video, regardless of Folder membership.
- Folder: `/f/<folderSlug>` — tiled gallery of the Folder's Videos.
- Video within a Folder: `/f/<folderSlug>/<videoSlug>` — the Video with a back-to-gallery affordance.
Slugs are short, unguessable, URL-safe random strings (~10 chars base62), generated via an injectable generator.

**Access resolution** (decision table encoding the privacy rules; from the prototype):
| Opened link | Folder protected? | Video protected? | Result |
|---|---|---|---|
| `/v/<v>` | n/a | no | play |
| `/v/<v>` | n/a | yes | prompt for the Video's password |
| `/f/<f>` | no | — | show gallery |
| `/f/<f>` | yes, not yet unlocked | — | prompt for the Folder's password |
| `/f/<f>/<v>` or gallery tile | unlocked (or none) | yes | play — folder access **cascades**, no second prompt |
| any, target expired/deleted/unknown | — | — | generic 404 (identical for expired, deleted, unknown — no existence leak) |

**Download deterrence** (ADR-0003). Segmented HLS (never a single grabbable file), no download control in the player, disabled context menu. AES-128, ABR ladders, and DRM are explicitly out (see Out of Scope). The limitation (determined capture is not prevented) is stated plainly in user-facing docs.

**Transcoding** (ADR-0005 defaults). One Rendition per Video: H.264 / AAC, capped at 1080p, 6-second HLS segments, `libx264 -preset veryfast` CRF 23, AAC 128k. Poster grabbed at ~10% of duration via `ffprobe`. Transcoding runs on an in-process background worker with capped concurrency so it doesn't starve the web server. Transcoding is reached through a **Transcoder port** (an interface), so the real `ffmpeg` implementation is swappable for a fake.

**Uploads.** Streamed straight to disk (never fully buffered). Operator-configurable max size (default ~2 GB); the cap is enforced during streaming (early-rejected via `Content-Length` when present), and any write failure (cap exceeded or disk full) aborts and deletes the partial file with a clear error.

**Auth & config.** First-run setup creates the Operator credential in SQLite; sign-in issues a signed, httpOnly session cookie. The session-signing secret is auto-generated and persisted on first run (overridable via env var). A CLI subcommand (run against the container) resets the Operator password directly in SQLite — no email/SMTP dependency. Rate limiting: a general per-IP limiter on public endpoints plus a stricter limiter on password attempts (both with configurable defaults).

**Deletion semantics.** Deleting a Video purges its Source + Rendition and immediately invalidates its Share Link. Deleting a Folder prompts the Operator to choose: delete the Folder and its Videos, or delete the Folder only and move its Videos to the Library root (ADR-0006). There is no in-place media replace in v1 (delete + re-upload, which mints a new link).

**Clock.** Expiry is evaluated against an injectable clock, so time-dependent behaviour is deterministic in tests.

## Testing Decisions

**What a good test is here.** Tests assert externally observable behaviour through the application's public boundary — the HTTP API and the link-resolution rules — never internal module shapes, private functions, or storage layout. A test should read as a description of operator/viewer behaviour (e.g. "a Folder link prompts once, then its Videos play without re-prompting").

**Primary seam — the HTTP API.** Almost everything is asserted by driving requests through the built Fastify app in-process (Fastify `inject`, no network), against a real temporary SQLite database and a temporary media directory. This single seam covers: upload acceptance and the Processing→Ready/Failed lifecycle, metadata, slug/link resolution for all three link kinds, Folder membership and the delete-folder choice, password + expiry + the Folder→Video cascade, the direct-Video-link no-sibling-leak rule, the unified 404, and rate limiting. Prefer this seam over any per-module unit tests.

**Injected fakes for determinism** (collaborators wired at app construction):
- **Transcoder port** — a fake that simulates Processing→Ready, Processing→Failed, and poster creation on command, so lifecycle transitions are driven synchronously through the API without invoking real `ffmpeg`.
- **Clock** — an injectable `now()` so expiry (Ready→Expired, extend) is testable without waiting.
- **Slug generator** — injectable so links are deterministic and collisions can be forced in tests.

**Modules under test.** The API/application layer (through the seam above) and the access-resolution rules. The real `ffmpeg`-backed Transcoder implementation is validated separately and lightly (it is the one slow, external, nondeterministic piece) rather than in the main behavioural suite.

**Prior art.** None — greenfield repo. This spec establishes the pattern: one in-process API seam + injected nondeterministic collaborators. Later tickets should follow it rather than introducing lower seams.

## Out of Scope

- **Multi-user / roles.** v1 is single-Operator; the operator/manager/creator role model is deferred.
- **Download hardening beyond deterrence.** AES-128 encrypted HLS is architected-for but off by default and not built in v1; DRM (Widevine/FairPlay) is permanently out.
- **Adaptive bitrate (ABR) ladder.** v1 produces a single Rendition; multi-rendition ladders are a later enhancement.
- **Resumable / chunked uploads** (e.g. `tus`) — deferred; v1 is streamed multipart.
- **External backends** — Postgres, Redis, and S3-compatible object storage are the documented scale-up path, not v1.
- **Bundled TLS / reverse proxy** — the Operator supplies their own.
- **Analytics** beyond a simple view count; **nested Folders** (one level only); **in-place media replacement**; **email/SMTP** anything.

## Further Notes

- The look & feel ("Studio Dark") and the operator/viewer flow ("Model 2": clicking a card opens a drawer; a Folder's drawer lists its Videos to drill into; **Preview** opens the real viewer experience in a new tab) were chosen via the throwaway prototype on branch **`prototype/look-and-feel`**. That branch remains the primary source for interaction detail; it is deliberately not on `main`.
- The toolkit and responsive behaviour are now settled (ADR-0008, ADR-0009; see **Operator & Viewer UI** above): shadcn/ui + Tailwind, mobile-first/portrait, toasts-for-success / persistent-copyable-errors. The prototype fixed direction and flow; this spec now fixes the toolkit and the mobile degradation. Fine-grained visual polish (exact spacing, iconography) still follows the prototype's direction rather than a pixel spec.
- Honesty constraint for user-facing docs: state plainly that nothing short of DRM stops a determined viewer, and that screen capture can never be prevented.
