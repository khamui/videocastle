# Uploads are resumable; a Video is born only when its bytes finish arriving

To support multi-file uploads from a phone — where locking the screen and
pocketing the device backgrounds and suspends the tab, killing an in-flight
plain-XHR upload — uploads use the **tus** resumable protocol (`@tus/server` on
Fastify, `tus-js-client` in the Dashboard). A suspended Upload resumes from its
last byte offset when the phone is woken, rather than restarting. No browser can
keep uploading while the screen is off; resumability is the achievable goal, and
it is what makes the pocket workflow reliable.

This **reverses** the prior behavior where the Video row and its Share Link
existed the instant a file *started* arriving (`POST /api/videos` returned `201`
immediately). A resumable Source is not whole until the last chunk lands, so a
Share Link created at start would point at a half-uploaded file. Instead, a tus
**Upload** is a pre-Video thing — temp storage, no row, no slug — and the Video
and its Share Link are created only on **completion**, which then enqueues
transcoding exactly as before. The optimistic Dashboard tile tracks the *upload*
and swaps for the real Processing card when the upload finishes, not when it
starts.

## Considered options

- **Create the Video row upfront in an "Uploading" lifecycle state** so every
  tile is backed by a real Video. Rejected: more moving parts, and a Share Link
  that resolves to a `404` until its bytes arrive — a worse thing to hand out
  than a link that does not yet exist.
- **Keep plain XHR and just loop over files.** Rejected: the stated goal is the
  phone-in-pocket case, which plain XHR cannot survive (ADR context above).

## Consequences

- **Abandoned partials** (an Upload started and never finished) consume disk.
  They **count against the storage figure** while present so they cannot
  silently pass the Quota, and are **reaped after 24h of inactivity**. This
  reaping is **outside ADR-0011**: a never-completed Upload is not a Video and
  not Operator media, so deleting it is not the "delete Operator media"
  ADR-0011 forbids.
- **Within a batch**, files upload **sequentially** — one Upload in flight at a
  time — which resumes cleanly, is kinder to a mobile radio, and keeps progress
  legible. The server still transcodes `TRANSCODE_CONCURRENCY` at a time.
- **The 15-file cap** (`MAX_UPLOAD_BATCH`, default 15) is a client-side
  selection guardrail; tus has no server-side notion of a batch, so the server
  instead caps the number of **concurrent incomplete Uploads** at the same
  figure. With exactly one trusted Operator (ADR-0001), this is disk safety, not
  abuse prevention.
- **Per-file storage check**: before each file starts, its declared
  `Upload-Length` is checked against the remaining allowance; a file that will
  not fit is refused with the existing 507-style refusal (ADR-0007), earlier
  completed files stay, and the batch continues to any that still fit. The
  mid-stream byte-ceiling remains the backstop for an understated length.
