# Live diagram embeds in documents and plans

## Decision

Solus documents and plans can embed a diagram work with a standalone Markdown reference:

```markdown
[System Architecture](work://embed?workId=<work-id>&type=diagram)
```

The reference is live inside Solus. The document does not copy diagram JSON. Editing stays in the source diagram, and the embedded preview reads the current work content.

## Authoring

Users insert an existing diagram with `/diagram`. Agents create the diagram work first and place the canonical token returned by `create_work` on its own line. Agents preserve existing embed tokens during document revisions unless the user asks to remove or replace them.

Agents create diagrams when the user asks for an architecture, system, data-flow, or ER view, or when component relationships are central to a durable document or plan. Routine plans remain prose-first.

## Rendering

The document editor parses the reference into a selectable, read-only block. It lazy-loads the source through `WorksStore`, renders the existing lightweight diagram preview, and opens the source work for editing. Loading, empty, missing, and invalid-work states are explicit.

The full interactive diagram canvas is not mounted inside a document. This keeps mounted tabs and Editor/Pill mode transitions inexpensive.

## Google Docs

Google upload takes a fixed snapshot at upload time:

1. Resolve and deduplicate diagram references.
2. Render each diagram through the deterministic light-theme SVG serializer.
3. Convert the SVG to PNG in the renderer.
4. Build sanitized HTML with inline base64 PNG figures.
5. Ask Drive to convert the HTML into a Google document.

Documents without diagram embeds keep the existing Markdown upload path. The upload never creates a public image URL and does not use DOCX. Later source-diagram edits do not change an existing Google document.

## Limits

- 20 unique diagrams per upload.
- 2 MB of generated SVG per diagram.
- 10 MB of generated SVG before image conversion.
- 12 MB of decoded PNG data at the server boundary.

Version one offers same-host diagrams in the picker. A missing or disconnected source stops Google upload rather than silently dropping the image.
