# Portable sessions

A signed-in person can continue one session on another host. Each ended turn is a Git commit. The next host restores the same code and provider thread before it runs.

## Sub-features

- Cloud push and fetch through the local Git storage provider.
- A host to host fallback when cloud sync is off.
- A typed failure when the source host is offline.
- Fork from a source session on another host.

## How to get to it (user POV)

Run a turn in a Git project. Pick another host in Run on and send the next prompt. The session keeps its id and history.

## Driving it with the Lab

From this checkout, run `bun lab build`. Then run `SOLUS_REPO="$PWD" SOLUS_CLOUD_DIR=/Users/sidhu/solus-cloud SOLUS_SESSION_STORAGE=local-git bun lab up --cloud` and `SOLUS_REPO="$PWD" SOLUS_CLOUD_DIR=/Users/sidhu/solus-cloud SOLUS_SESSION_STORAGE=local-git bun lab run portable-sessions --cloud`. Run `bun lab down` when done. The run writes checks and host logs under `.solus-local/lab-cloud/evidence/`.

## Gotchas

- Run `bun install` in a fresh worktree before starting the cloud; it supplies `node_modules/expo/tsconfig.base.json`. The Lab introduces its two hosts to give their local HTTP routes verified identity keys.
- When a cloud push is still pending and the last host is offline, source choice retries the cloud for at most 15 seconds. Stop cancels this wait.
- The prompt context puts `forked` on the session. `forkSourceSessionId` and the source head go on the prompt options.
- The refused push and both recovery actions are in the scenario. The organization read-standing case still needs a persona with read-only standing on a published organization session.
