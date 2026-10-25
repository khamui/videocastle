# Discarding the Source is optional, and the choice is forward-only

A Video's Source is kept on the server after transcoding (GLOSSARY: Source),
which roughly doubles the disk a Video costs. The Host Configuration can turn
that off, trading the ability to re-transcode for the disk it buys back. The
default is unchanged: keep the Source.

The choice is **forward-only**. Turning Source retention off affects only
Videos transcoded afterwards; every Source already on disk stays there. Sources
the Operator already holds are reclaimed only by an explicit, separately-invoked
CLI action, never as a side effect of flipping a setting, and never by the
running server. The alternative — sweeping existing Sources the moment the
setting changes — makes a one-line config edit silently destroy originals the
Operator may be the only remaining holder of, with no undo and no warning. A
setting that reads as "stop keeping these from now on" must not mean "destroy
the ones I kept".

A Video whose Source is gone can never be re-transcoded. Retry is therefore
shown as unavailable for it, with the reason stated, rather than offered and
then failing (ADR-0007): the Operator learns the consequence from the Dashboard
at the moment it matters, not from a failed transcode.

See ADR-0011 for the companion rule that storage pressure never deletes
Operator media.
