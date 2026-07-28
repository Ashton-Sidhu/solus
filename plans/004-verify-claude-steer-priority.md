# Plan 004: Verify and encode Claude steering priority

> **Executor instructions**: Verify SDK behavior before changing production
> semantics. Run each command, honor STOP conditions, and update
> `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat de80040..HEAD -- package.json bun.lock src/main/agents/claude/claude-turn-input.ts src/main/agents/claude/claude-backend.ts tests/unit/claude-steering.test.ts`
> Stop if the installed Agent SDK version or steering-message construction has
> changed without corresponding documentation.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-simplify-steering-contract.md`
- **Category**: bug investigation
- **Planned at**: commit `de80040`, 2026-07-27

## Why this matters

The installed Claude Agent SDK exposes user-message priorities `now`, `next`,
and `later`, while Solus sends steering messages without one. The implementation
claims same-turn steering, so it must verify that the SDK default really means
immediate steering or explicitly set the correct priority. This should be
evidence-led, not guessed from field names.

## Current state

- `package.json` requests `@anthropic-ai/claude-agent-sdk ^0.2.141`; the
  installed package was `0.2.141` during the audit.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3657-3669` defines:

```ts
export declare type SDKUserMessage = {
  type: 'user'
  message: MessageParam
  parent_tool_use_id: string | null
  priority?: 'now' | 'next' | 'later'
  shouldQuery?: boolean
}
```

- `src/main/agents/claude/claude-backend.ts:85-94` constructs both opening and
  steered messages without distinguishing their delivery priority.
- `tests/unit/claude-steering.test.ts:37-87` proves the message enters the open
  async iterable, but not how the SDK schedules it relative to active work.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Claude steering tests | `bun test tests/unit/claude-steering.test.ts` | all pass |
| Build | `bun run build` | exit 0 |

## Scope

**In scope**

- `src/main/agents/claude/claude-backend.ts`
- `src/main/agents/claude/claude-turn-input.ts` only if test instrumentation or
  message construction belongs there
- `tests/unit/claude-steering.test.ts`
- `package.json`/`bun.lock` only if the installed SDK version lacks a documented
  usable contract and an approved patch upgrade provides it

**Out of scope**

- Migrating to Claude Managed Agents
- Replacing the Agent SDK
- Changing background-task lifetime policy
- Inferring semantics solely from minified SDK implementation

## Git workflow

- Suggested branch: `advisor/004-claude-steer-priority`
- Commit message example: `fix: mark Claude steering input as immediate`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Establish the SDK contract

Check the installed type declarations, official Agent SDK documentation, and
upstream release notes/source for `SDKUserMessage.priority`. Record in the test
name or a short code comment whether:

- omitted priority defaults to immediate steering;
- `priority: 'now'` is required for immediate steering; or
- the field controls a different concept.

Do not cite the separate Managed Agents API as proof for Agent SDK behavior.

**Verify**:
the evidence identifies one unambiguous behavior. Otherwise trigger the STOP
condition.

### Step 2: Encode only the necessary distinction

If `now` is required, allow `buildUserMessage` to receive the priority and set
`priority: 'now'` only for steering messages. Keep the opening message at the
documented default unless the SDK requires otherwise. Avoid a new wrapper if a
single optional parameter is sufficient.

If omission is documented as immediate, make no production change; add a
regression comment/test only if it can verify meaningful behavior rather than
the mock.

**Verify**:
`bun test tests/unit/claude-steering.test.ts` passes.

### Step 3: Test the outgoing SDK message

When production sets a priority, assert the delivered mid-turn
`SDKUserMessage.priority` in the existing “delivers into the turn” test. Also
assert the opening message does not accidentally inherit an inappropriate
priority.

**Verify**:
`bun test tests/unit/claude-steering.test.ts` exits 0.

## Test plan

- Mid-turn input has the documented immediate-steering priority.
- Opening input retains correct default semantics.
- Closed/missing handles still refuse steering.
- Image content remains unchanged.

## Done criteria

- [ ] SDK priority behavior is established from an authoritative Agent SDK
  source.
- [ ] Production explicitly encodes immediate steering if required.
- [ ] Tests assert the chosen behavior.
- [ ] `bun test tests/unit/claude-steering.test.ts` passes.
- [ ] `bun run build` passes.
- [ ] Dependency files change only if an SDK upgrade was necessary.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Official/current Agent SDK sources do not define the priority semantics.
- Correct steering requires interrupting the active Claude query rather than
  streaming a prioritized message; report this as a product behavior decision.
- The required API exists only in a breaking SDK version.

## Maintenance notes

Recheck this contract on Agent SDK upgrades. The test should fail if message
construction stops carrying the explicit scheduling intent.

