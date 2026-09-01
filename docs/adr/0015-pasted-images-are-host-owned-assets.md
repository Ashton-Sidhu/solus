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

This decision first refused GitHub's asset upload endpoint because it was
undocumented. That reason has expired. The GitHub CLI now uploads assets through
it for `gh issue create/edit/comment` and `gh pr create/edit/comment`
(cli/cli#13256, stack cli/cli#14186), and those pull requests state the
credential, file-type, size, and failure contract. The endpoint is therefore a
supported path with a first-party reference implementation, not a private one.
See `docs/plans/github-asset-publishing.md`.

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
support this through its attachment API. GitHub uploads to
`uploads.github.com/user-attachments/assets`, the endpoint its own command-line
client uses.

An upload is irreversible and the task sync engine retries, so a publication is
recorded against the asset digest and the provider target. A retry reuses the
recorded provider URL rather than uploading the bytes again.

The GitHub upload accepts an OAuth token, a classic personal access token, or a
fine-grained personal access token, and rejects both GitHub App token types. Solus
must therefore keep issuing OAuth device-flow tokens for GitHub, or lose asset
publishing. The endpoint answers 404, not 403, when a token cannot write.

Publishing that cannot proceed — an unsupported file type, a file over the
provider limit, insufficient permission, or a provider with no attachment API —
keeps the content local and offers the provider web composer.

## Consequences

- Repeated attachment bytes with the same extension occupy one host file.
- Markdown and task records stay small.
- A remote client never receives or assumes a host filesystem path.
- Signed render URLs expire without changing durable Markdown.
- A screenshot published to a repository uploads once, however many comments on
  that repository reference it.
- Durable Markdown keeps `asset://` after publication. Only the body sent upstream
  carries the provider URL.
- Moving GitHub authentication to a GitHub App would break asset publishing.
- Removing every reference does not yet delete the immutable host file.
  Reference tracking and garbage collection can be added separately without
  changing the Markdown contract.
