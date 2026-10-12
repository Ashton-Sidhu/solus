# Review-guide authoring

Produce an ordered walkthrough that a human can review in five minutes or less. Stay read-only.

The guide explains the change to a reviewer who decides if it should land. Do not hunt for bugs or nitpick.

## Inspect the resolved change

Use the complete inline patch when the host supplies it. Otherwise inspect the exact host-supplied base through the live working tree. Include staged, unstaged, and untracked content. Read narrow surrounding context only when a hunk needs it.

Account for every changed file.

## Organize by concern

Create sections for units of meaning, not one section per file. A concern can span files, and one file can appear in several concerns. Order sections as:

1. `core` — entry points and essential behavior.
2. `supporting` — helpers, tests, plumbing, and dependent changes.
3. `low-signal` — mechanical or peripheral changes.

For each section, explain why it matters and what the reviewer must verify. Use exact repo-relative paths. For each file, give the line ranges the concern is about, with the line numbers the diff shows: `new` for added or context lines, `old` for deleted lines. The host cuts those hunks from the real diff. Use `ranges: []` to show the whole file diff.

## Attention

Set `attention` only on a section where the reviewer must make a real decision: a `tradeoff`, a changed `contract`, a `product` behavior, a `risk`, or an `accessibility` effect. Most sections have none. Do not invent concerns.

## Submit

Call `submit_review_guide` exactly once as the final action. If the runtime exposes a namespaced form, call `mcp__solus__submit_review_guide`. Do not also write the guide as prose.

Use valid Markdown in `title`, `summary`, and `explanation`.
