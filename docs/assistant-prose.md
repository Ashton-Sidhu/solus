# Assistant prose

Desktop and web share the transcript styles in
`packages/workspace-ui/src/workspace.css`.

Assistant body text uses weight 400. Headings and Markdown bold use weight 600.
Assistant prose uses normal letter spacing, independent of UI font tracking.
Paragraphs have `0.65rem` vertical margins. Adjacent paragraph margins collapse;
the first and last blocks have no outer margin. Paragraphs inside list items
retain the list's spacing.

The centered conversation column uses 65% of the available pane width, up to
68rem on desktop and web. Assistant prose and embedded previews use the full
column. The input dock and status rows share that column.

Mobile uses the T3 Code native markdown renderer's spacing rules with regular
body text, weight 600 for assistant bold, and bold headings.
On mobile, the conversation column uses 65% of the available width, subject to
its existing maximum content width. Assistant message rows use the full column.
