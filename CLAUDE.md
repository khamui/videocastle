## Design principles

- **Operator-facing errors are technical, verbose, and shareable** (ADR-0007).
  The Operator owns the server, so Dashboard/API/CLI/log errors state the real
  cause and carry the raw diagnostic (exit codes, ffmpeg stderr, paths, a stable
  `reason` code) for copy-paste bug reports — never genericised. Exceptions that
  stay deliberately opaque: the Viewer surface (ADR-0002, generic 404s) and
  credential/auth responses (anti-enumeration). Full detail there goes to the
  server log, not the response.

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each mapped to a label of the same name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
