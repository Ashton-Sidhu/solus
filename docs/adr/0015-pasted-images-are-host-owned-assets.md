# ADR-0015: Pasted attachments are host-owned assets

## Status

Accepted

## Context

Task descriptions, comments, documents, and diagrams can contain screenshots
and other file attachments. Embedding each file as Base64 Markdown makes every content record large,
duplicates bytes, and sends those bytes through SQLite, IPC, WebSocket, and
task synchronization paths. A renderer can also be on a different machine from
the host that owns the content.

Provider publishing is a separate concern. Jira has an official attachment
API. GitHub's official issue and pull-request comment APIs accept Markdown text
but do not provide an attachment upload operation.

## Decision

The content-owning host stores pasted or dropped files under its Solus data
directory, addressed by a SHA-256 digest and a validated file extension.
Markdown stores only `asset://<digest>.<extension>`.

Clients upload bytes through the typed `assetUpload` RPC. Rendering reuses the
host's existing asset-preview path. Its temporary URL is a transport detail,
not durable content and not a provider-facing URL. Editors may use an object
URL only for the thumbnail shown while an upload is pending.

The host accepts files up to 10 MB. PNG, JPEG, GIF, and WebP render inline only
after the host verifies their declared MIME type against the file signature.
Other files render as attachment links and download with `nosniff` protection;
they do not execute inline. SVG is therefore a file attachment, not an inline image.

External publishing remains provider-specific. A provider adapter reads the
local bytes, uploads them as a provider attachment or media object, and replaces
the local reference with provider-native inline markup. Thus a screenshot can
render inline while still using the provider's attachment storage. Jira can
support this through its attachment API. GitHub publishing must use its web
composer or a separately approved asset-mirroring strategy; Solus must not use
GitHub's undocumented upload endpoint.

## Consequences

- Repeated attachment bytes with the same extension occupy one host file.
- Markdown and task records stay small.
- A remote client never receives or assumes a host filesystem path.
- Signed render URLs expire without changing durable Markdown.
- Removing every reference does not yet delete the immutable host file.
  Reference tracking and garbage collection can be added separately without
  changing the Markdown contract.
