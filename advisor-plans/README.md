# Git and pull request workflow plans

Planned against commit `13d7e340` on 2026-08-15.

| Plan | Priority | Size | Depends on | Status |
|---|---:|---:|---|---|
| [001 Workspace project catalog](001-workspace-project-catalog.md) | P1 | M | — | Ready |
| [002 Workspace-wide PR inbox](002-workspace-pr-inbox.md) | P1 | L | 001 | Ready |
| [003 Commit options](003-commit-options.md) | P1 | M | — | Ready |
| [004 Initialize and publish repository](004-initialize-publish-repository.md) | P1 | L | — | Ready |
| [005 Explicit PR checkout](005-explicit-pr-checkout.md) | P1 | M | — | Ready |

## Scope rules

- Support GitHub only. Do not add GitLab, Bitbucket, or Azure DevOps behavior.
- Preserve the existing automatic commit and automatic commit-and-push actions.
- Keep all host operations behind the typed RPC contract.
- Implement applicable behavior for desktop, web, and mobile clients.
- Do not start a development server or use live Solus data for verification.

