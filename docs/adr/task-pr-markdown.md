# Task and pull-request Markdown

Task descriptions, task comments, pull-request descriptions, review comments,
and review-guide text use `GithubMarkdown` in the shared workspace UI. Desktop,
web, and mobile use the same component.

Complete documents pass through remark (CommonMark and GFM), GitHub alert
recognition, rehype raw-HTML parsing, and rehype sanitization. A recursive Svelte
component renders the sanitized tree. Native `details` and `summary` elements
keep nested content together and support opening and closing. Fenced code stays
inside one `pre` element; inline-code components do not process its lines.

The default remote-content policy removes unsafe HTML, event handlers, and
application-specific URL schemes. Task and local review-guide content opt into
the local policy to retain Solus references and supported inline raster images.
Both policies sanitize HTML. Existing media cards and read-only task checkboxes
remain available.

Task descriptions use this renderer when read. The Edit description control
opens the existing editor; Save description and Cancel return to the read view.
Streaming conversations use a separate incremental Markdown renderer because
partial turns are not complete documents. It is not part of the task and
pull-request Markdown path.

Regression coverage is in `tests/unit/github-markdown.test.ts`, including nested
CodeRabbit disclosures, alerts, fenced code, tables, media, and sanitization.
