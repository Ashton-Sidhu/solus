# 0022. A published Solus diagram is a Confluence page attachment

## Status

Accepted, 2026-09-02.

## Context

A Solus document embeds a diagram as a link on its own line:
`[Target Architecture](work://embed?workId=…&type=diagram)`.

Google Docs publishes that as an inline image (ADR 0020). Confluence did not.
`prepareDocument` sent diagram images only when the provider was `gdrive`, so
a Confluence publish rewrote every embed into a caption —
`_Diagram: Target Architecture — view it in Solus._` — and named it in
`lossyParts`. A published architecture document therefore contained no
architecture, and the next pull wrote that caption back over the live embed
token, deleting the diagram from the work that owned it.

Confluence shows an image from exactly two sources: an attachment on the page
itself, or a URL it can fetch anonymously. A rendered diagram is neither. It
is also not a paginated medium — a page scrolls — so none of the page fitting,
landscape sections, and tiling that ADR 0020 needed applies here.

## Decision

A diagram published to Confluence is uploaded as an attachment on its own
page, and the page body points at it.

- The filename is `solus-diagram-<workId>.png`. That name is the round trip:
  a pull reads the work id out of it and the title out of the image's `ac:alt`,
  and rebuilds the `work://embed` token with no help from the link. It is also
  why a republish replaces the picture instead of adding a second copy —
  `PUT` on the attachment collection is create-or-update by filename.
- An attachment whose name is not ours stays an image link and is still named
  in `lossyParts`, as before.
- Attachments go up before the body that references them, so the page is never
  published pointing at a picture that is not there. On a create the page must
  exist first, so there the order is reversed and the upload follows
  immediately. Confluence may count an upload as an edit, so an update re-reads
  the page version after uploading — the caller's conflict guard has already
  run against the version it was given.
- The diagram is drawn as the canvas has it: no page fit, no re-layout. The
  storage format keeps a small diagram at its authored width and holds a wide
  one to the 760 px content column. The capture targets 500 dpi at that shown
  width, enough for 200% zoom on a high-density display with margin. The shown
  width is recovered from the PNG and that target, so an export that reaches
  the 20-megapixel raster ceiling becomes smaller instead of becoming soft.
- `prepareDocument` no longer names a provider. A publish that carries rendered
  diagrams keeps its embeds; one that carries none — an agent's `publish_work`,
  where the server has no canvas — gets the caption fallback. That is the real
  distinction, and it was always the one that mattered.

Uploading an attachment has no v2 endpoint, so it runs on the v1 API, and v1
honours the **classic** `write:confluence-file` scope: a first live publish
with only the granular `write:attachment:confluence` was refused with a 401,
so the granular scope is not requested at all — nothing here calls a v2
attachment endpoint. An existing grant does not carry the classic scope, so a
connection made before this change reports it as a `limitation` and refuses a
diagram publish before writing anything, rather than failing partway through.

That first 401 arrived with its reason discarded: v1 answers in a third error
dialect, a flat `statusCode`/`message` pair, which `describeFailure` did not
read. It does now, and a refused write logs `atlassian_request_refused` with
the scopes the grant actually carries.

## Consequences

- The Atlassian app registration must offer `write:confluence-file`
  ("Upload Confluence attachments"). Until a user signs in again, their
  Confluence publishes keep the captions.
- A diagram is published at its authored size. A very wide graph is legible
  only when opened, the same as it is on the Solus canvas — Confluence has no
  page to fit it to, and inventing one would help nobody.
- Removing a diagram from a document leaves its attachment on the page.
  Deleting attachments is destructive and would need to distinguish ours from
  a person's beyond a filename convention; it is not done.
- A page imported on a machine that does not have the diagram work shows the
  editor's existing "Diagram no longer exists" card. That is the same state a
  deleted diagram produces, and it names what is missing.
