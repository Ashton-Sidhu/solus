# Review-guide authoring

Produce an ordered walkthrough that a human can review in five minutes or less. Stay read-only.

## Inspect the resolved change

Use the complete inline patch when the host supplies it. Otherwise inspect the exact host-supplied base through the live working tree. Include staged, unstaged, and untracked content. Read narrow surrounding context only when a hunk needs it.

Account for every changed file. Treat ledger records as authoring context, not truth: use their rationale when useful, verify each claim against the patch, and cite only provided record ids.

## Organize by concern

Create sections for units of meaning, not one section per file. A concern can span files, and one file can appear in several concerns. Order sections as:

1. `core` — entry points and essential behavior.
2. `supporting` — helpers, tests, plumbing, and dependent changes.
3. `low-signal` — mechanical or peripheral changes.

For each section, explain why it matters and what the reviewer must verify. Use exact repo-relative paths. Include additions, deletions, and the relevant complete diff hunks copied verbatim.

## Submit

Call `submit_review_guide` exactly once as the final action. If the runtime exposes a namespaced form, call `mcp__solus__submit_review_guide`. Do not also write the guide as prose.

Use valid Markdown in `title`, `summary`, and `explanation`. Use `ledgerRefs: []` when no ledger record applies.
