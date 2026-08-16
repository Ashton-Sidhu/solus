# 004 — Initialize Git and publish to GitHub

## Objective

Let a user initialize Git in an opened folder and publish a local repository to GitHub. GitHub is the only remote provider in scope.

## Product behavior

### Initialize

- When an opened project folder is not a Git repository, offer **Initialize Git**.
- Initialize with the configured default branch; use `main` when no valid preference exists.
- Do not create an automatic initial commit.
- Refresh Git state after success.

### Publish

- When a Git repository has no primary remote, offer **Publish to GitHub** if GitHub authentication is available on that host.
- Form fields: owner, repository name, visibility (private by default), remote name (`origin` by default), and HTTPS or SSH remote protocol.
- Create the repository under the selected owner, add a credential-free remote URL, then push and set upstream when local commits exist.
- With no local commits, create the GitHub repository and add the remote without pushing.
- If GitHub creation succeeds but remote setup or push fails, never delete the GitHub repository. Show its URL and a retry path.
- If the GitHub repository already exists, connect only after its owner/name identity matches the requested target.

## Implementation outline

1. Read setup clone/adopt handlers and contracts, Git provider/auth infrastructure, Octokit usage, `HostApi`/preload/WebSocket exposure, repository-state stores, and open-project UI callers.
2. Add exact shared request/result types and typed RPC methods for initialize and GitHub publish. Results must report partial completion explicitly: created URL, remote added, push completed, and recoverable error stage.
3. Execute all filesystem, Git, and GitHub operations on the selected host. Do not send local filesystem assumptions to clients.
4. Validate the project root, repository name, owner, remote name, protocol, existing remotes, and current repository state. Do not place tokens in remote URLs, logs, or results.
5. Reuse the current GitHub credential/provider service. Keep provider-specific behavior behind the provider boundary.
6. Make retries idempotent: detect the already-created matching GitHub repository and existing matching remote; reject mismatches instead of overwriting.
7. Add UI entry points in the empty/non-repository Git state and repository actions. Use a focused store for durable loading/error/result state; components must not call loaders directly.
8. On success or partial success, refresh repository state and remember the project in the workspace project catalog from plan 001 when that catalog is available. Do not make this plan depend on plan 001 to compile.
9. Add clear unauthenticated, permission, name-conflict, remote-conflict, no-commit, push-failure, reconnect, and retry states.

## Acceptance criteria

- A non-repository folder can become a Git repository on its actual host.
- Initialization makes no commit and uses the correct default branch.
- An authenticated GitHub user can create private/public repositories and choose HTTPS/SSH.
- No credentials enter stored remote URLs or RPC payloads returned to the renderer.
- Partial failures preserve remote state and offer a safe retry.
- Desktop, hosted desktop, web, and mobile route through the same host contract.

## Verification

- Add temporary-directory Git tests and mocked GitHub provider tests for initialize, publish with/without commits, idempotent retry, existing-repository mismatch, remote conflict, and push failure.
- Run the focused tests, `bun run lint:types`, `bun run lint:hosts`, and `bun run build`.

