# MCP visual pass handoff

Branch `solus/mcp-ui-visual-polish`, from `main` at `5bb58455a`. Nothing was
pushed. No pull request was opened. Status: in progress.

## Part 1: the merge of F2 and D

- `e605c02f1` merges `solus/mcp-resource-watches` (`aa68b80ab`, F2).
- `1bbb046d2` merges `solus/discover-running-local-mcp-servers` (`090995f57`,
  D).
- One conflict, in `docs/plans/mcp-first-class.md`: the status line and §1.
  Both sets of corrections are kept. F2's items stay 38 and 39; D's items are
  now 40 to 46, and `mcp-d-handoff.md` names the new numbers.
- `docs/integrations.md`, `boot-server.ts`, and `gateway.ts` merged
  automatically. Each result was read: the sections and the wiring of the two
  phases do not touch each other.
- `bun test tests/unit/integrations/` and the test files that the two branches
  added or changed: 414 pass, 2 fail. The 2 are `data-model-identity`, which
  fails on `main` with the same assertions.
- Type checks (`tsc --noEmit`): contracts 0, client-core 2, mobile 0, server
  134, workspace-ui 40, the same counts as `main`. The one diagnostic in a
  changed file (`boot-server.ts`, `AddressInfo`) is a line of `main` that the
  merge moved.

## Part 2: the visual pass

Committed so far (groups 1 to 4 and their mobile parts):

- `4352dc055` the MCP App card and its approval dialog.
- `41f6be2de` MCP tool names (defect a) and the Solus audio player.
- `fd5b3945e` the stop icon on MCP task and resource watch rows (the
  maintainer's feedback).
- `428a68f95` the close icon of the MCP prompt form.

Still to do: group 5 (Settings → MCP, uncommitted edits in the working tree:
the dialog surface, the Found row buttons, the command value, the
instructions text; mobile: the two disclosures), its screenshots, the
first-screen bytes, and this document's final form.

Screenshot harness (not committed): `.tmp/vp/` in this worktree, a Vite
server on 127.0.0.1:5291 with `vite.config.mts`, `harness.html`, and
`Harness.svelte`; `shot.ts` and `compose.ts` drive system Chrome. Vite does
not watch this worktree (its path has `/.git/`), so restart it after an edit
(`.tmp/vp/restart.sh`, which stops only its own PID).
