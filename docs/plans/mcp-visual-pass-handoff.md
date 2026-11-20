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

(In progress. Each group is recorded here when its commit is made.)
