# Plan 001: Preserve and classify Codex steer errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command before moving on. If a STOP condition occurs, stop and
> report rather than improvising. When complete, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat de80040..HEAD -- src/main/agents/codex/codex-agent.ts src/main/agents/codex/codex-protocol.ts src/main/agents/codex/codex-backend.ts tests/unit/codex-steering.test.ts`
> The working tree was already dirty when this plan was written. Compare the
> excerpts below to live code; stop if their steering/error shape changed.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `de80040`, 2026-07-27

## Why this matters

`CodexBackend.steerSession` currently converts every rejected JSON-RPC request
into `not-active`. A crashed app-server, timeout, authentication failure, or
protocol bug therefore becomes a queued prompt that may execute later. Only an
expected-turn/active-turn precondition failure is a safe queue fallback; all
other failures must remain failures.

## Current state

- `src/main/agents/codex/codex-agent.ts:180-189` discards JSON-RPC `code` and
  `data`, rejecting with only `new Error(response.error.message)`.
- `src/main/agents/codex/codex-protocol.ts:40-45` already models the complete
  JSON-RPC error payload.
- `src/main/agents/codex/codex-backend.ts:451-465` catches every error and
  returns `'not-active'`.
- `tests/unit/codex-steering.test.ts:47-62` uses a generic `Error` to represent
  the expected turn-boundary race, so it accidentally blesses the broad catch.

Current broad fallback:

```ts
try {
  const response = await this.client.request<CodexTurnSteerResponse>('turn/steer', params)
  // ...
  return 'accepted'
} catch (error) {
  log.info(`Codex steer rejected ...`)
  return 'not-active'
}
```

Match the repository's existing style: small typed errors beside the client
that creates them, `instanceof` narrowing at the consumer, and focused Bun
tests with injected fake clients.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `bun test tests/unit/codex-steering.test.ts` | all tests pass |
| Build | `bun run build` | exit 0; warnings are acceptable |

## Scope

**In scope**

- `src/main/agents/codex/codex-agent.ts`
- `src/main/agents/codex/codex-protocol.ts`
- `src/main/agents/codex/codex-backend.ts`
- `tests/unit/codex-steering.test.ts`

**Out of scope**

- Generated files under `src/main/agents/codex/generated/`
- General Codex restart/retry policy
- Queue behavior in `src/main/control-plane.ts`

## Git workflow

- Suggested branch: `advisor/001-codex-steer-errors`
- Use one logical commit, e.g. `fix: preserve Codex steering failures`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Preserve JSON-RPC error metadata

Add a small exported `CodexRpcError` in `codex-agent.ts` (or
`codex-protocol.ts` if imports remain cleaner) containing `code` and `data`.
Construct it in `onResponse` instead of `new Error(message)`. Do not stringify
or log arbitrary `data`.

**Verify**:
`bun test tests/unit/codex-steering.test.ts` must still pass before changing
classification.

### Step 2: Classify only the expected refusal as `not-active`

Add a narrow predicate in `codex-backend.ts` for the actual app-server
turn-boundary error. Prefer structured `error.data`/`error.code`; use a message
fallback only if the installed protocol supplies no stable structure. Re-throw
timeouts, process failures, auth errors, bad requests, and unknown errors.

The backend contract remains: expected boundary races return `not-active`;
provider failures reject.

**Verify**:
`bun test tests/unit/codex-steering.test.ts` exits 0.

### Step 3: Encode both outcomes in tests

Update the existing race test to throw a structured `CodexRpcError`. Add one
test where `client.request` throws an unrelated error and assert that
`steerSession` rejects with that error rather than returning `not-active`.

**Verify**:
`bun test tests/unit/codex-steering.test.ts` exits 0 with at least three steering
tests.

## Test plan

- Accepted steer with text/images remains covered.
- Structured active-turn mismatch returns `not-active`.
- Transport/timeout/unknown failure rejects.
- Unexpected returned turn ID remains a refusal unless protocol documentation
  proves it should be a hard failure.

## Done criteria

- [ ] JSON-RPC code/data survive rejection as typed fields.
- [ ] Only a verified active-turn precondition failure returns `not-active`.
- [ ] An unrelated steer error rejects in a focused test.
- [ ] `bun test tests/unit/codex-steering.test.ts` passes.
- [ ] `bun run build` passes.
- [ ] No generated protocol files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- The app-server supplies no stable code, data, or distinguishable message for
  an active-turn mismatch. Report the observed payload before choosing a
  heuristic.
- Preserving error metadata requires changing every Codex client caller.
- Focused tests fail for unrelated initialization/process-spawn reasons twice.

## Maintenance notes

Keep the classification narrow. New app-server refusal variants should be added
with a captured payload and regression test, never by broadening the catch to
all errors again.

