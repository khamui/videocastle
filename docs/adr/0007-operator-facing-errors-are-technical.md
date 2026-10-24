# Operator-facing errors are technical, verbose, and shareable

The Operator is the server's owner and a technical user (ADR-0001: self-hosting
ethos), so every error the Operator can see — Dashboard messages, the JSON API
behind the session, CLI output, and server logs — states the real, specific,
technical cause rather than a reassuring-but-useless "something went wrong". A
failure names what failed, why, and where to look, and carries the underlying
diagnostic (exit codes, `ffmpeg`/`ffprobe` stderr, probe output, file paths,
stack traces, a stable machine `reason` code) verbatim, so the Operator can
copy it into a bug report or paste it to a maintainer and we can fix it without
a reproduction round-trip. We do not sanitise, truncate beyond a sane cap, or
genericise these messages for a non-technical audience that this product does
not have; "proxified" friendly errors are an anti-goal on the Operator surface.
The first embodiment is the transcode pipeline: a failed Video stores a
`failure_reason` plus a trimmed stderr `failure_detail`, both surfaced on the
Dashboard and in the API, and the server logs the full error.

This principle is bounded by two surfaces that stay deliberately opaque, and it
must never be used to justify leaking there:

- **The Viewer surface (ADR-0002).** Viewers are untrusted and unauthenticated;
  expired, deleted, and unknown links all return the same generic "not
  available" response, and playback problems show a neutral message. Verbose
  errors never reach a Viewer — that would leak existence and internals.
- **Credential / auth responses.** Sign-in and setup answer with non-committal,
  constant-shape results (e.g. unknown username and wrong password are
  identical) to resist account enumeration and timing oracles. The technical
  detail of an auth failure belongs only in the server log, not the response.

The cost is that operator-facing output assumes technical literacy and can
include internals that would be reckless to expose on a public, multi-tenant, or
untrusted surface — which is exactly why the two carve-outs above are drawn
sharply. We accept that trade because the Operator owns the box, and fast,
honest, shareable diagnostics are worth more to them than polish.
