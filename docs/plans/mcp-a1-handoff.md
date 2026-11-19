# MCP merge and A1 handoff

Branch: `solus/merge-mcp-branches-and-build-a1-facts`. The worktree is clean.
Nothing was pushed. No pull request was opened.

## Commits

- `82af1132e`: merge OAuth authorization rules (`1e3a107de`).
- `18cc6a74a`: merge MCP Apps host parity (`2c97b896d`, `e3192c1b1`).
- `101a22b46`: merge the MCP first-class plan (`8f6a74389`).
- `3a0848839`: add modern list-change and fake-clock elicitation tests; repair the OAuth test fake.
- `bfefe7ed9`: implement A1 server facts, instructions, RPC, and Settings display.

The MCP Apps branch was named `solus/mcp-apps-host-parity` in this checkout;
its two commits match the branch named `solus/e1aa7b97` in the task.

## Merges

All three merges completed automatically. There were no conflict markers or
manual resolutions. Git retained the OAuth discovery and revision handshake
edits in `probe.ts`, the SDK import and MCP Apps edits in `mcp-apps.ts`,
and all sections in `docs/plans/mcp-integrations.md`. `bun install
--ignore-scripts` completed and made no tracked lockfile change.

## Base-commit checks

A detached worktree at `f6ba8c919` was installed, tested, and removed.
The base and merged schema-size test both measured 110,064 bytes against
107,583. This failure predates the branches. The base server `check`
produced 143 TypeScript diagnostics after line numbers were normalized.
The merged head and A1 head each produced 130. No diagnostic text was added
by the merge or A1.

`run-launcher.ts` was 1,006 lines at the base, 1,006 after the merges, and
1,009 after A1. This work did not push it over the 1,000-line limit.

## Tests and checks

- Part 1 focused suite: 302 pass, 0 fail, 24 files.
- Final MCP suite with A1 runtime instruction tests: 327 pass, 0 fail, 25 files.
- A1 integrations and runtime instruction subset: 240 pass, 0 fail, 17 files.
- Contracts `check`, mobile `check`, Svelte row parse, and `git diff --check`: pass.
- Server `check`: 130 existing normalized diagnostics; no new A1 diagnostic.
- Client core `check`: two existing `Window.solus` and `Window.solusNative`
  declaration errors. Workspace UI `check`: existing diagnostics outside A1
  files; no A1 file appears in the output.
- Targeted `oxlint`: existing complexity and other findings in large touched
  files; no finding points to an A1 line. The root `lint:types` and
  `lint:hosts` scripts do not exist.
- `native-mobile-integrations.test.ts`: 48 pass, one existing label assertion
  fails. The test and label implementation are unchanged from `f6ba8c919`.

## A1 names and ownership

`IntegrationGateway` owns the in-memory `serverFacts` cache, replacing
`ToolCache` and `caches`. It holds the tool list, era, instructions,
capabilities, expiry, and stale state for one integration and person. The
gateway retains `revisions` for the SDK `PriorDiscovery` verdict.

`integrationToolbox(actor, projectKey?)` replaces `integrationAgentTools`
and returns `{ tools, instructions }`. An instruction entry is
`{ name, slug, text }`. Only a server that adds a model tool contributes
instructions. `runtimeInstructions` appends the marked MCP block after
Solus blocks. Claude receives it through `systemPromptAppend`; Codex
receives it through thread developer instructions. Each server contributes
at most 2,000 characters; the block is at most 10,000 characters.

`IntegrationFacts` is in `packages/contracts/src/integration-types.ts`.
`integrationFacts({ id })` is an execution RPC with `host.use` access
and the existing integration owner check. `integration.changed` adds
`change: 'facts'`. Desktop and web share the Settings row; mobile has its
own closed, read-only “Instructions for the agent” section. Their stores
reload open rows on a facts change. A1 adds no table. The later
`integration_server_facts` table and `server-facts-store.ts` belong to B1.

The plan said `server-facts-store.ts` owned the verdict, but P0 keeps it
in the gateway's in-memory `revisions` map. The plan now states this.
It also named two root lint scripts that do not exist; §17 now names
the available checks. A1 adds no progress, result-content, stdio,
discovery, prompts, resources, or MCP tasks.

## Open verification

No light or dark screenshot was captured. No demo server for this worktree
was running. The task forbids starting a dev server and forbids a build.
The implemented Settings row therefore has no visual capture yet.
The existing mobile label failure, typecheck failures, and lint findings
remain open.
