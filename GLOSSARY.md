# videocastle

A self-hostable app for private, straightforward video sharing: an Operator uploads a Video, it is transcoded to streamable HLS, and a Share Link is handed out to Viewers. Privacy means the media stays on the Operator's own server and access is gated only by an unguessable link.

## Language

**Operator**:
The single trusted person who runs an instance and uploads and manages its Videos. v1 has exactly one per instance; distinct management roles may come later.
_Avoid_: admin, user, creator

**Viewer**:
Anyone who opens a Share Link to watch a Video. Has no account and never logs in.
_Avoid_: user, guest

**Video**:
A single piece of content an Operator has uploaded and shares as one unit. The logical item that a Share Link points at.
_Avoid_: clip, media, asset

**Source**:
The original file an Operator uploaded, kept on the server as-is.
_Avoid_: original, raw, master

**Rendition**:
The HLS-transcoded, streamable output produced from a Source. v1 produces exactly one Rendition per Video.
_Avoid_: variant, version, output

**Folder**:
An Operator-created, shareable group of Videos, exactly one level deep — a Folder never contains another Folder. A Video belongs to at most one Folder.
_Avoid_: collection, album, playlist, gallery

**Library**:
The Operator's complete set of Videos and Folders. A Video that is in no Folder sits directly in the Library. The Library as a whole is never shareable; only a Folder or an individual Video can be.
_Avoid_: root, home, workspace

**Share Link**:
The unguessable URL that grants viewing access to a single Video or a whole Folder. The link itself is the only secret; possession of it is permission to view. The Library as a whole is never shareable.
_Avoid_: public link, URL, share URL

**Processing**:
The lifecycle state of a Video after upload while its Rendition is being transcoded. A Share Link exists immediately but is not yet playable.
_Avoid_: pending, encoding, queued

**Failed**:
The lifecycle state of a Video whose transcode errored. The Source is retained so the Operator can retry or delete; Viewers see a neutral "temporarily unavailable" message.
_Avoid_: errored, broken

**Dashboard**:
The Operator-only interface for uploading Videos and managing their titles, links, and lifecycle.
_Avoid_: admin panel, console

**Watch Page**:
The Viewer-facing page reached through a Share Link, where a ready Video plays.
_Avoid_: player page, view page

**Gallery**:
The Viewer-facing page a Folder's Share Link opens: the grid of that Folder's Videos, from which a Viewer opens any one's Watch Page. The Folder analogue of the Watch Page. Distinct from the Folder itself (the group of Videos) — the Gallery is how a Viewer sees it.
_Avoid_: overview, grid, album

**Poster**:
The single still frame grabbed from a Source and shown on the Watch Page before playback begins.
_Avoid_: thumbnail, preview, cover

**Portrait-optimized**:
An Operator display hint on a Video (and a Folder default its Videos inherit) for footage whose meaningful content sits in the vertical centre of the frame — e.g. a portrait clip pillarboxed inside a landscape edit. A Viewer on a portrait screen then sees the frame cropped to fill vertically, with a control to reveal the whole frame; it is ignored on a landscape screen. A display choice only — it never changes the stored Video or its Rendition.
_Avoid_: vertical mode, crop, zoom

**Autoplay**:
An Operator playback setting on a Video (and a Folder default its Videos inherit) that lives entirely in the Share Link: when on, the link carries `?autoplay=on`, and the Watch Page starts the Video automatically — _muted_, the only autoplay browsers reliably allow without a Viewer gesture, so the Viewer unmutes from the native controls. Nothing is hidden: the Watch Page autoplays if and only if `?autoplay=on` is present, so a Viewer opts out by removing the param or in by adding it, and a browser that still blocks it simply leaves the Poster up. Off by default — a plain link, where opening it fetches nothing until the Viewer presses play. A playback choice only — it never changes the stored Video or its Rendition.
_Avoid_: auto-start, play on load (unmuted)

**Host Configuration**:
The settings that only the person running the server decides, fixed when the instance starts and never editable from the Dashboard. Distinct from the Operator's own choices about their Videos, which are theirs to change at any time.
_Avoid_: settings, options, env vars, admin config

**Quota**:
The ceiling the Host Configuration puts on how much disk this instance's media may occupy. Reaching it stops new Videos arriving; it never removes Videos that are already there.
_Avoid_: limit, cap, allowance, max size
