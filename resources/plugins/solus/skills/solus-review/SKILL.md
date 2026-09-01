---
name: solus-review
description: Request or author a Solus structured review guide for working-tree, session, branch, or pull-request changes. Use for the `/review` command family and background review-guide production.
---

# Solus review

The host prompt supplies one explicit mode. Do not infer the mode from the user's prose.

## Request mode

Call `request_review_guide` exactly once with the target selected by the command. The tool stays open while the hidden author produces the guide; wait for it to return. Do not run Git commands, inspect files, author a guide, or repeat the guide as assistant prose. End after the tool returns. For a PR URL, parse its host, owner, repository, and positive PR number into the typed PR target; the server resolves and prepares the exact revision.

Target mapping:

- `/review` and `/review:working-tree` → `{ "kind": "working-tree" }`
- `/review:session` → `{ "kind": "session" }`
- `/review:branch` → `{ "kind": "branch" }`
- `/review:pr` and `/review <PR URL>` → the PR target supplied by the host

## Author mode

Read [references/authoring.md](references/authoring.md), inspect only the resolved change supplied by the host, and call `submit_review_guide` exactly once. The tool arguments are the deliverable.
