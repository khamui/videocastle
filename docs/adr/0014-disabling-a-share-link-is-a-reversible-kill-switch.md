# Disabling a Share Link is a reversible kill switch, separate from expiry

An Operator can **disable** a Share Link — a Video's `/v/` link or a Folder's
`/f/` gallery link — to switch it off at once, and later re-enable it. A
disabled link returns the same generic Viewer 404 as an expired or unknown one
(ADR-0002), so from the Viewer's side it is simply gone; re-enabling restores it
unchanged. Disable is an explicit, deliberate act and is fully reversible: the
slug, media, password, and expiry all survive, and flipping it back on brings
the link straight back to life.

**Disabled is its own state, not a reuse of expiry.** We considered expressing
"switched off" by setting an expiry in the past, which the machinery for the
generic 404 already supports. We rejected it because the two carry different
meaning the Operator needs to keep apart: "I switched this off" is a standing
decision they made and can undo, while "it lapsed on its own" is the clock
having passed an instant they set. Collapsing them would make the Share Links
overview unable to say which links the Operator killed versus which simply ran
out — and would make re-enabling ambiguous (restore to never-expire, or to some
former instant?). So `disabled` is an additive boolean on both `videos` and
`folders`, independent of `expiresAt`.

**The three conditions are independent, and Expired wins the badge.** A link can
be active, disabled, and/or expired in any combination. For Viewer access the
distinction does not matter — disabled *or* expired collapses to the one generic
404, exactly as deleted and unknown do (ADR-0002, no existence leak). For what
the Operator sees, when a link is both disabled and expired the **Expired**
status is shown: expiry is the condition the Operator can't simply toggle away
(re-enabling a disabled-and-expired link would still leave it expired), so it is
the more honest thing to surface first.

**Disable is allowed in any lifecycle state.** A Video that is Processing or
Failed has a Share Link the moment it is born (GLOSSARY: Processing), and the
Operator may want to switch that link off before the transcode finishes or after
it fails. Disable therefore does not depend on state — it gates the link, not the
media.

**Folder disable cascades only by opt-in, and only on the way down.** Disabling
a Folder darkens its `/f/` gallery link; whether it also disables the member
Videos' own `/v/` links is a choice the Operator makes at disable time (default:
gallery only). Re-enabling a Folder restores the gallery link only and never
cascades — the cascade was a one-way, disable-time decision, so re-enabling can't
guess which member links the Operator had independently switched off. This
mirrors how expiry and the rest of the sharing model already treat a Folder and
its Videos as independently shareable units (ADR-0006): only the password
cascades to viewing, never the link's own on/off or expiry.

**Disable is not slug rotation.** Because it is reversible, disable does not
"revoke a URL forever" — a re-enable brings the same slug back. Truly burning a
URL (rotating the slug so a leaked link can never work again) is a separate,
deliberately out-of-scope concern; `delete` remains the irreversible option for a
Video, and nothing here changes it.

See ADR-0002 for the generic-404 access model this reuses, and ADR-0006 for the
Folder/Video sharing model whose independence this follows.
