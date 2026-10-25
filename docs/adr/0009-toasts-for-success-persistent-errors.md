# Operator feedback: transient toasts for success, persistent surfaces for errors

On the operator Dashboard, success and informational confirmations are shown as
**transient, auto-dismissing toasts** (the Model 2 prototype's bottom-centre
pattern: "Link copied", "Moved", "Folder created"), but **errors are never
toasts**. An operator-facing error renders in a **persistent, dismissible
surface** — inline in the drawer/form that triggered it, or a sticky error card
— that shows the real technical cause, the raw diagnostic, and the stable
machine `reason` code, and stays on screen until the operator dismisses it.

This refines ADR-0007 at the presentation layer. ADR-0007 requires that every
error the operator sees be verbose, technical and *copy-pasteable into a bug
report*; a toast that vanishes in ~1.7s is the opposite of copy-pasteable, so
routing errors through the confirmation-toast channel would quietly defeat
ADR-0007. Splitting the two channels keeps confirmations unobtrusive while
guaranteeing an error can always be read in full and copied.

The ADR-0007 carve-outs are unchanged: the Viewer surface stays opaque
(ADR-0002) and credential/auth responses stay constant-shape — neither gets a
verbose error surface regardless of channel.
