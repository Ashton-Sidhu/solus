# Plan 002: Make steering eligibility and backend outcomes explicit

> **Executor instructions**: Follow each step and verification gate. Stop on a
> listed condition rather than broadening scope. Update `plans/README.md` when
> complete.
>
> **Drift check (run first)**:
> `git diff --stat de80040..HEAD -- src/shared/types.ts src/main/agents/agent-backend.ts src/main/agents/claude/claude-backend.ts src/main/agents/codex/codex-backend.ts src/main/control-plane.ts src/renderer/components/input/InputBar.svelte tests/unit/control-plane-device-tabs.test.ts`
> Compare the excerpts below because these files had uncommitted work at plan
> creation.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-preserve-codex-steer-errors.md`
- **Category**: bug, tech-debt
- **Planned at**: commit `de80040`, 2026-07-27

## Why this matters

The renderer says only `running` sessions can steer, while `ControlPlane`
attempts steering for every status considered busy. Meanwhile `steerSession`
is optional even though the UI claims every provider supports it, and the
control plane/backend perform duplicate handle lookups. This plan creates one
explicit eligibility rule and one outcome contract before the renderer state
is simplified in Plan 003.

## Current state

- `src/renderer/components/input/InputBar.svelte:73-79` computes `canSteer` from
  `running`, excluding `connecting`.
- `src/renderer/contexts/workspace/workspace.context.svelte.ts:1245` considers
  only `running` locally busy for optimistic message handling.
- `src/main/control-plane.ts:1011-1035` attempts steering for every
  `_isBusyStatus`.
- `src/main/control-plane.ts:1500-1507` defines busy as `connecting`,
  `running`, `awaiting_input`, `awaiting_plan`, or `rate_limited`.
- `src/main/agents/agent-backend.ts:62-65` makes `steerSession` optional and
  returns a string union.
- `src/main/control-plane.ts:1066-1073` looks up a handle before the backend,
  while each backend looks it up again.
- The same `user_message` literal exists at `control-plane.ts:1052-1058`,
  `1756-1768`, and `2294-2301`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Control-plane steering tests | `bun test tests/unit/control-plane-device-tabs.test.ts -t "steer"` | all matched tests pass |
| Provider tests | `bun test tests/unit/claude-steering.test.ts tests/unit/codex-steering.test.ts` | all pass |
| Build | `bun run build` | exit 0 |

## Scope

**In scope**

- `src/shared/types.ts`
- `src/main/agents/agent-backend.ts`
- `src/main/agents/claude/claude-backend.ts`
- `src/main/agents/codex/codex-backend.ts`
- `src/main/control-plane.ts`
- `src/renderer/components/input/InputBar.svelte`
- `src/renderer/contexts/workspace/workspace.context.svelte.ts`
- `tests/unit/control-plane-device-tabs.test.ts`
- Provider steering tests when required by the return-type change

**Out of scope**

- Renderer outbox/pending collection replacement (Plan 003)
- Rate-limit queue policy
- General extraction of the large control-plane/workspace files
- Adding a third provider

## Git workflow

- Suggested branch: `advisor/002-steering-contract`
- Commit message example: `refactor: make steering outcomes explicit`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Name the canonical steering eligibility

Separate “session is busy” from “turn can accept steering.” Use a shared,
meaningful rule or type predicate consumed by both main and renderer. Do not
make every busy status steerable merely to preserve current behavior.

Recommended product rule:

- `running`: steerable.
- `connecting`: not steerable; submission is blocked or queued by existing
  connection behavior.
- `rate_limited`: not steerable; existing rate-limit policy decides.
- `awaiting_input` / `awaiting_plan`: queue from the composer unless product
  behavior explicitly requires steering here. The dedicated permission,
  question, and plan controls continue the active turn.

If existing product tests prove composer input during `awaiting_input` is meant
to steer, include that status in both layers and add a named test.

**Verify**:
`bun test tests/unit/control-plane-device-tabs.test.ts -t "steer"` passes.

### Step 2: Return the accepted handle from the backend

Change the backend outcome to a discriminated result or `RunHandle | null`.
The accepted outcome must provide the exact handle whose turn accepted the
input; refusal returns `null`; genuine provider errors reject. Remove the
control plane's pre-call `getSessionHandle` lookup.

Make support either:

1. required on `AgentBackend`, because both registered providers support it; or
2. an explicit metadata capability consumed by `InputBar`.

Prefer the required method unless a real registered backend cannot implement a
safe `null` fallback. Do not keep the current optional method plus unconditional
UI claim.

**Verify**:
provider steering tests and the filtered control-plane tests pass.

### Step 3: Centralize user-message event construction

Use `_userMessageEvent` from accepted steering, normal resumed-run broadcast,
and queued-run dequeue. Add any protocol fields once in this helper. Preserve
`displayPrompt`, image attachments, and automation metadata exactly.

Do not add a pass-through wrapper; this helper earns its existence by being the
single serializer for three paths.

**Verify**:
`rg -n "type: 'user_message'" src/main/control-plane.ts` reports the helper plus
only unrelated event construction, not three dispatch serializers.

### Step 4: Add a status matrix test

Extend `control-plane-device-tabs.test.ts` with table-driven cases for
`running`, `connecting`, `awaiting_input`, `awaiting_plan`, and `rate_limited`.
Each case must assert whether the backend steer method was called and whether
the resulting disposition is `steered`, `queued`, or blocked by the existing
rate-limit path.

Add a test that an accepted backend handle supplies the returned lifecycle's
`done` promise.

**Verify**:
`bun test tests/unit/control-plane-device-tabs.test.ts -t "steer"` exits 0.

## Test plan

- Default interactive delivery steers only canonical steerable statuses.
- Explicit `delivery: 'queue'` never calls the backend steer method.
- Expected backend refusal falls back to queue/start at the turn boundary.
- Provider rejection remains rejection after Plan 001.
- Accepted steer shares the active handle's completion lifecycle.

## Done criteria

- [ ] Main and renderer use one named steering-eligibility rule.
- [ ] Backend support is required or represented by a real capability.
- [ ] Accepted steering returns its authoritative handle.
- [ ] Control plane performs no duplicate pre-steer handle lookup.
- [ ] User-message event construction has one dispatch serializer.
- [ ] Status-matrix tests pass.
- [ ] Provider steering tests pass.
- [ ] `bun run build` passes.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A registered backend other than Claude/Codex exists and cannot implement the
  required steering contract.
- Existing tests demonstrate composer input during an awaiting status has a
  different intentional product meaning. Report the conflict instead of
  averaging behaviors.
- The status rule requires changing permission/question/plan response APIs.

## Maintenance notes

Future session statuses must choose explicitly whether they are busy,
steerable, both, or neither. Do not reuse `_isBusyStatus` as a steering test.

