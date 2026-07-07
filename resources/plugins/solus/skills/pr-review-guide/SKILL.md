---
name: pr-review-guide
description: Produce Solus structured code-review walkthroughs for branch or PR changes. Use when an agent is reviewing an agent-authored code change, generating a guided review, organizing a PR into review concerns, or calling the Solus `submit_review_guide` tool with title, summary, and ordered sections.
---

# PR review guide

Produce a guided review: an ordered walkthrough in the order that the code gets executed. The human reviewer should be able to review the PR in 5 min or less.

The host prompt supplies the branch, target branch, base commit, working tree, and optional review ledger. Inspect the actual change yourself before submitting the guide.

## Review workflow

1. Start with `git diff <base> --stat` for the file list.
2. Read the patch with `git diff <base>`, scoping to files with `-- <path>` when useful.
3. List untracked files with `git ls-files --others --exclude-standard`; read each in full because they are part of the change but do not appear in `git diff`.
4. Use file reads and narrow searches to inspect surrounding context for hunks that need it.
5. Account for every changed file in at least one section. Put purely mechanical files in a low-signal section.

Stay read-only. Use only file reads and read-only git commands. Do not edit, format, commit, or run write-producing shell commands.

## Organize by concern

Create sections for concerns, not one section per file. A concern is a unit of meaning that may span several files; the same file may appear in more than one concern.

Order sections the way a reviewer should read the change:

1. `core`: entry points and essential behavior.
2. `supporting`: helpers, tests, plumbing, and dependent changes.
3. `low-signal`: mechanical edits, renames, formatting, generated files, or peripheral churn.

Prefer 4-8 focused sections over many tiny sections. Group trivial edits together.

Per section:

- Explain why the concern matters, verified against the diff.
- State the single thing the reviewer should check. Use a Markdown list when there is more than one concrete check.
- Include exact repo-relative file paths as they appear in the diff.
- Include additions and deletions for each file.
- Cite ledger record ids in `ledgerRefs` only when they directly support the section.

## Use the ledger

When ledger JSON is provided, treat it as authoring context, not truth. It contains intent, rationale, assumptions, alternatives, edge cases, omissions, and questions that a raw diff cannot express.

Use ledger records as the primary source for each section's "why", but verify every claim against the diff. Do not cite ledger ids that are not present in the provided ledger.

## Submit the guide

Call `submit_review_guide` exactly once as the final action. If the runtime exposes the namespaced MCP form, call `mcp__solus__submit_review_guide`. The tool arguments are the deliverable; do not also write the guide as prose.

Shape:

The `title`, `summary` and section `explanation` fields should all be valid markdown, no exceptions.

```json
{
  "title": "One-line title for the whole change",
  "summary": "A 1-3 sentence overview of what changed and why.",
  "sections": [
    {
      "id": "stable-slug",
      "title": "Short section title",
      "order": 0,
      "significance": "core",
      "explanation": "Markdown explanation of why this matters and what to verify.",
      "ledgerRefs": ["ledger-record-id"],
      "files": [
        { "path": "src/example.ts", "additions": 12, "deletions": 3 }
      ]
    }
  ]
}
```

Valid `significance` values are `core`, `supporting`, and `low-signal`. Use `ledgerRefs: []` when no ledger is present or no record applies.
