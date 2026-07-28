# Plan 005: Unify agent dispatch through the control plane

> **Executor instructions**: Follow this plan in order. Preserve behavior with
> compatibility adapters while migrating; do not delete an old path until every
> caller has moved and the corresponding tests pass. Run every verification gate.
> Stop on a listed condition instead of broadening scope. Update
> `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat de80040..HEAD -- src/main/agents src/main/control-plane.ts src/main/boot-core.ts src/main/server/index.ts src/main/server/handlers/worktree-handlers.ts src/main/folio/work-tools.ts src/main/folio/artifact-tools.ts src/main/automations/automation-tools.ts src/main/automations/automation-runner.ts src/main/sessions/session-tools.ts src/main/tasks/task-tools.ts src/main/providers/pr-tools.ts src/main/review tests/unit`
>
> Several in-scope files already had uncommitted changes when this plan was
> written. Compare the live code against the "Current state" section before
> editing. Do not discard or overwrite those changes.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/003-unify-outbound-prompt-state.md`,
  `plans/004-verify-claude-steer-priority.md`
- **Category**: tech-debt, architecture
- **Planned at**: commit `de80040`, 2026-07-28

## Why this matters

Solus currently has one provider path for interactive/session runs and several
provider-specific utility paths for text generation, review-guide generation,
and cross-provider subagents. Tool availability is also assembled twice:
Claude receives hand-built SDK MCP tools while Codex receives separately
assembled JSON schemas plus a name-based dispatcher. This makes a new tool or
new run type require coordinated changes across provider-specific code.

After this plan, every caller will submit one provider-neutral agent-run
request. Each service will explicitly choose the Solus tools available to that
run from a shared toolbox and route it through `ControlPlane.runAgent()`.
The control plane will delegate provider mechanics to one internal runner,
which translates tools into the format expected by Claude or Codex and owns
timeout/cancellation/output collection. There will be no named run-profile
registry, no provider-native-capability model, and no service-side execution
path around the control plane.

## Architectural decision

Implement these ownership boundaries:

```text
Interactive/session turns ───┐
TextGenerator ───────────────┤
Review guide producer ───────┼── ControlPlane.runAgent()
Cross-provider subagents ────┤            │
Automations ─────────────────┘            ▼
                                  internal AgentRunner
                                           │
                                           ▼
                              ClaudeBackend / CodexBackend
```

- **Calling service** owns the exact `AgentTool[]` selection and run intent,
  then submits the request through the control plane.
- **Calling service** also owns prompt composition. Product settings, review
  context, and other feature-specific guidance must be rendered into `prompt`
  or `systemPrompt` before dispatch.
- **Solus toolbox** owns provider-neutral tool names, descriptions, Zod input
  shapes, approval metadata, and execution.
- **ControlPlane** is the sole application-facing dispatch boundary for every
  agent run, including tabless and ephemeral work. It owns run registration,
  provider availability policy, shutdown cancellation, and optional
  session/tab/queue lifecycle.
- **AgentRunner** is an internal control-plane dependency. It owns provider
  selection mechanics, timeout wiring, cancellation, final output, and
  run-scoped event delivery. No feature service receives it directly.
- **Claude/Codex adapters** translate the same selected tools into SDK MCP tools
  or Codex dynamic tools. They retain provider-native built-in behavior
  internally; it is not part of `AgentRunRequest`.
- For session-backed work, **ControlPlane** additionally owns tabs, sessions,
  queueing, rate limits, persistence/indexing, changed-file and snapshot state,
  late attachment, attention, and steering.

Do not introduce `toolProfile`, `runProfile`, or a registry keyed by workload
names such as `"review"` or `"automation"`. A service's selected tool array is
the source of truth.

`AgentRunRequest` is a stateless execution envelope, not a transport for
application features or durable session state. In particular, it must not
contain review objects, changed-file lists, git checkout objects, settings
fragments, or provider-specific instruction fields. Domain owners compose
those values before calling `ControlPlane.runAgent()` or retain them in their
own lifecycle state.

## Target contracts

Create the following main-process-only contracts. Exact generic syntax may
follow the installed Zod types, but preserve the semantics and names.

```ts
// src/main/agents/tools/agent-tool.ts
import { z } from 'zod'
import type { AgentId, NormalizedEvent } from '../../../shared/types'

export interface AgentToolResult {
  ok: boolean
  text: string
}

export interface AgentToolContext {
  provider: AgentId
  cwd: string
  sessionId: () => string | undefined
  abortSignal: AbortSignal
  emit: (event: NormalizedEvent) => void
}

export interface AgentTool<TShape extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  inputShape: TShape
  /** Whether interactive ask mode must route this tool through permission UI. */
  requiresApproval: boolean
  execute(
    input: z.output<z.ZodObject<TShape>>,
    context: AgentToolContext,
  ): Promise<AgentToolResult>
}
```

Use a small `defineAgentTool()` helper only if it preserves Zod inference; it
must not be a pass-through wrapper with no type or validation value.

```ts
// src/main/agents/agent-runner.ts
export interface AgentRunRequest {
  provider: AgentId
  prompt: string
  cwd: string
  tools: AgentTool[]

  model?: string | null
  reasoningEffort?: ReasoningEffort
  permissionMode: 'ask' | 'auto' | 'plan'
  persistence: 'session' | 'ephemeral'

  sessionId?: string | null
  forkSession?: boolean
  additionalDirectories?: string[]
  imageAttachments?: Attachment[]
  contextWindow?: number | null
  fastMode?: boolean
  systemPrompt?: string
  maxTurns?: number
  maxBudgetUsd?: number
  timeoutMs?: number

  onEvent?: (event: NormalizedEvent) => void
}

export interface AgentRunResult {
  sessionId: string | null
  output: string
  toolCallCount: number
  permissionDenials: Array<{ tool_name: string; tool_use_id: string }>
  exitCode: number | null
  signal: string | null
}

export interface AgentRun {
  /** Existing session ids resolve immediately; fresh ids resolve at session_init. */
  sessionId: Promise<string | null>
  done: Promise<AgentRunResult>
  cancel(): void
  /** Kept for ControlPlane steering/session bookkeeping. */
  handle: RunHandle
}
```

If provider constraints require a narrower internal request, add that type
inside the provider folder. Do not leak Claude SDK or Codex protocol types into
`AgentRunRequest`, `AgentTool`, callers, or the toolbox.

The omissions above are intentional:

- `extraInstructions`, model-specific instructions, review guidance, and
  similar behavioral inputs are composed into `systemPrompt` by the calling
  service.
- A checkout contributes its resolved working directory to `cwd`; the checkout
  object remains owned by `ControlPlane` or the originating service.
- `sessionChangedFiles` remains in ControlPlane/session snapshot state. It is
  never an agent execution input.
- Provider session identity (`sessionId`/`forkSession`) is allowed because it
  selects the provider conversation being executed; it does not carry Solus
  feature state.

## Current state

### Execution

- `src/main/agents/agent-backend.ts:26-41` defines `RunHandle`; final text is
  written to `resultText` and completion is exposed as `runPromise`.
- `src/main/agents/agent-backend.ts:54-90` defines the session-oriented backend
  interface. `startRun` currently accepts `SessionRunInput` plus
  `PromptOptions`.
- `src/main/control-plane.ts:989-1051` is the canonical session dispatch path.
- `src/main/control-plane.ts:1291-1363` already starts isolated automations as
  normal tabless sessions and follows their `RunHandle` to completion.
- `src/main/agents/text-generator.ts:23-147` independently branches between
  Claude and raw Codex app-server execution.
- `src/main/agents/codex/codex-oneshot.ts:132-313` independently starts Codex
  threads, routes notifications, dispatches tools, and collects final text.
- `src/main/review/review-agent.ts:90-147` branches between
  `runCodexOneShot()` and direct `ClaudeAgent.run()`.
- `src/main/agents/codex/codex-subagent-tool.ts:63-94` calls
  `runCodexOneShot()` and forwards nested events.
- `src/main/agents/claude/claude-subagent-tool.ts:102-171` directly constructs a
  `ClaudeAgent`, MCP server, tool list, event loop, and final-text collector.

### Tool duplication

- `src/main/folio/work-tools.ts:20-30` explicitly exports three provider
  shapes: Claude SDK tools, Codex JSON descriptors, and a plain executor.
- `src/main/folio/work-tools.ts:306-363` builds Claude's complete Solus MCP
  server and decides whether automation and subagent tools are present.
- `src/main/folio/work-tools.ts:373-384` separately exports Codex descriptors
  and classification sets.
- Automation, session, task, PR, and artifact tool modules repeat the same
  SDK-tool/JSON-schema/plain-executor split.
- `src/main/agents/codex/codex-solus-tools.ts:44-148` reconstructs the catalog by
  tool-name sets, classifies approval behavior, dispatches to domain executors,
  and concatenates Codex schemas.
- `src/main/agents/claude/claude-backend.ts:183-302` creates the full MCP server
  and separately hard-codes pre-approved MCP names.
- `src/main/agents/codex/codex-backend.ts:321-340` registers the Codex schemas;
  `:853-969` separately parses and dispatches dynamic calls.
- `src/shared/types.ts:1071-1074` carries `toolProfile?: 'interactive' |
  'automation'`; its only purpose is choosing whether automation tools are
  included.

### Existing behavior that must survive

- Interactive runs receive every current Solus tool, including the opposite
  provider's subagent tool.
- Automation runs receive the current Solus suite except automation CRUD/run
  tools; this is the recursion guard.
- Cross-provider subagents receive the current non-automation Solus suite, but
  do not receive either subagent tool; nested subagent spawning stays disabled.
- Text generation receives `tools: []`, remains ephemeral, honors
  `timeoutMs`/`maxTurns`, and does not appear in session history.
- Review generation receives only `submit_review_guide` from the Solus toolbox.
  It stays read-only and ephemeral and preserves structured capture and progress
  updates.
- In interactive ask mode, selected tools marked `requiresApproval` route
  through the existing permission UI. Unselected tools are unavailable, not
  merely denied after the model calls them.
- Plan/read-only mode must continue denying writes. Auto mode may execute every
  selected tool without UI approval.
- Tool-created work/task/session/automation/artifact events continue to appear
  in a watching conversation. Utility callers can receive events through
  `onEvent` without creating a tab.
- Claude/Codex native filesystem, shell, web, and built-in tools retain their
  current provider behavior. They are not added to the neutral toolbox or the
  request contract.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Existing headless lifecycle | `bun test tests/unit/control-plane-device-tabs.test.ts -t "headless"` | all matched tests pass |
| Existing Codex one-shot characterization | `bun test tests/unit/codex-oneshot.test.ts` | pass until deleted in the final migration step |
| Tool/adapter tests | `bun test tests/unit/agent-toolbox.test.ts tests/unit/agent-tool-adapters.test.ts` | all pass |
| Runner/control-plane dispatch tests | `bun test tests/unit/agent-runner.test.ts tests/unit/control-plane-agent-dispatch.test.ts` | all pass |
| Utility caller tests | `bun test tests/unit/text-generator.test.ts tests/unit/review-agent-control-plane.test.ts tests/unit/cross-provider-subagent-control-plane.test.ts` | all pass |
| Focused regression suite | `bun test tests/unit/control-plane-device-tabs.test.ts tests/unit/session-tools-search.test.ts tests/unit/codex-subagent-event-bridge.test.ts tests/unit/session-event-subagent.test.ts tests/unit/automation-run-cwd.test.ts` | all pass |
| Build | `bun run build` | exit 0; warnings are allowed, errors are not |

The worktree baseline was not green when this plan was written: a focused run
of `control-plane-device-tabs.test.ts` plus `codex-oneshot.test.ts` produced 15
passes and 4 failures. The automation completion test and Codex one-shot test
passed. Record the exact baseline before editing, and do not use pre-existing
failures as permission to weaken assertions.

## Scope

### In scope

New files:

- `src/main/agents/agent-runner.ts`
- `src/main/agents/tools/agent-tool.ts`
- `src/main/agents/tools/solus-toolbox.ts`
- `src/main/agents/claude/claude-tool-adapter.ts`
- `src/main/agents/codex/codex-tool-adapter.ts`
- Focused unit tests listed in "Commands you will need"

Existing files:

- `src/main/agents/agent-backend.ts`
- `src/main/agents/base-backend.ts`
- `src/main/agents/backend-registry.ts`
- `src/main/agents/system-hint.ts`
- `src/main/agents/claude/claude-agent.ts`
- `src/main/agents/claude/claude-backend.ts`
- `src/main/agents/claude/claude-subagent-tool.ts`
- `src/main/agents/codex/codex-agent.ts`
- `src/main/agents/codex/codex-backend.ts`
- `src/main/agents/codex/codex-oneshot.ts` (delete after migration)
- `src/main/agents/codex/codex-solus-tools.ts` (delete after migration)
- `src/main/agents/codex/codex-subagent-tool.ts`
- `src/main/agents/text-generator.ts`
- `src/main/control-plane.ts`
- `src/main/boot-core.ts`
- `src/main/server/index.ts`
- `src/main/server/handlers/worktree-handlers.ts`
- `src/main/folio/work-tools.ts`
- `src/main/folio/artifact-tools.ts`
- `src/main/automations/automation-tools.ts`
- `src/main/automations/automation-runner.ts` only if dependency injection must
  carry the control-plane dispatcher; do not change automation
  scheduling/store semantics
- `src/main/sessions/session-tools.ts`
- `src/main/tasks/task-tools.ts`
- `src/main/providers/pr-tools.ts`
- `src/main/review/review-agent.ts`
- `src/main/review/review-guide-tool.ts`
- `src/main/review/guide-producer.ts`
- `src/main/server/handlers/review-handlers.ts`
- `src/shared/types.ts` only to remove `toolProfile`
- `tests/e2e/mock/backend-registry.ts` and its mock backend contract when the
  backend signature changes

### Out of scope

- Provider-native capability abstraction or normalization
- Changes to which provider-native Claude/Codex tools are available
- A named run-profile registry
- Renderer tool selection UI
- Plugin/third-party tool discovery
- Moving tool execution out of the main process
- Changes to RPC wire types for renderer-authored prompts
- Automation scheduling, overlap policy, storage, or result status semantics
- Review-guide content/schema changes
- Changes to session queueing, steering rules, rate-limit policy, worktree
  creation, or session handoff
- Adding a third agent provider
- General refactoring of `ControlPlane` or the domain tool executors

## Git workflow

- Suggested branch: `advisor/005-agent-runner-tools`
- Use staged logical commits:
  1. `refactor: define provider-neutral agent tools`
  2. `refactor: route agent tools through provider adapters`
  3. `refactor: add shared control-plane agent dispatch`
  4. `refactor: route agent services through control plane`
  5. `refactor: remove one-shot agent paths`
- Do not push or open a PR unless instructed.
- Never discard the uncommitted changes already present in this worktree.

## Steps

### Step 0: Record characterization behavior and baseline

Before changing production code:

1. Run the existing headless, one-shot, automation, review, and subagent tests.
2. Record failures that already exist.
3. Add characterization tests where current behavior has no direct assertion:
   - Text generation supplies no Solus tools for both providers.
   - Interactive sessions expose the same current Solus tool names.
   - Automation sessions omit every automation tool but retain the rest.
   - Cross-provider subagents omit automation and nested-subagent tools.
   - Review runs expose only `submit_review_guide`.
   - A run with no tab still captures final output.
   - App, model-specific, and PR-review guidance appears in the effective
     system prompt for both providers.
   - Changed-file state survives sequential session turns and produces the
     same snapshot inputs for both providers.

These tests may initially assert through current provider-specific seams. They
must be rewritten to assert the neutral request/tool selection after migration,
not deleted.

**Verify**:

```sh
bun test tests/unit/control-plane-device-tabs.test.ts -t "headless"
bun test tests/unit/codex-oneshot.test.ts
bun test tests/unit/automation-run-cwd.test.ts tests/unit/codex-subagent-event-bridge.test.ts tests/unit/session-event-subagent.test.ts
```

Expected: no regressions relative to the recorded baseline.

### Step 1: Define the provider-neutral tool contract

Add `agent-tool.ts` with the target contracts above.

Requirements:

- `inputShape` is the canonical Zod shape. Claude receives it directly; Codex
  receives `z.toJSONSchema(z.object(inputShape))`.
- Both adapters validate arguments with the same Zod object before calling
  `execute`. Do not rely on Claude validation while passing unchecked Codex
  input.
- `requiresApproval` replaces the scattered `*_MUTATING_TOOLS` classification
  sets. Preserve current behavior exactly, including intentional cases such as
  `create_work` not prompting while `update_work` does.
- `AgentToolContext` carries dynamic per-run state. `sessionId` is a getter
  because a new provider session has no id until initialization.
- `execute` returns `{ ok, text }`; provider response serialization belongs in
  adapters.
- Reject duplicate selected tool names before starting the provider. This
  catches accidental toolbox composition errors deterministically.

Create adapter unit tests using two fake tools:

- one successful read tool;
- one approval-required tool;
- invalid arguments;
- duplicate names;
- execution returning `{ ok: false }`.

**Verify**:
`bun test tests/unit/agent-tool-adapters.test.ts` passes.

### Step 2: Convert each domain tool module to neutral definitions

In each domain module, retain its existing business executor and add/export
neutral `AgentTool` definitions backed by that executor:

- Works: five tools
- Artifact: `render_artifact`
- Automations: every existing automation tool
- Sessions: every existing session tool
- Tasks: every existing task tool
- PRs: every existing PR tool

The neutral wrapper is responsible for translating `AgentToolContext` into the
domain executor's existing dependency shape and for emitting the same
`NormalizedEvent` currently produced by backend-specific callbacks. Examples:

- `create_work` emits `work_created`;
- `update_work` emits `work_updated`;
- `render_artifact` emits `artifact_created`;
- automation saves emit `automation_saved`;
- session create/prompt/stop emit their existing card events;
- task creation emits `task_created`.

Do not rewrite the domain business logic or error messages. Initially keep the
old SDK/JSON exports as compatibility adapters so existing callers compile.

Add `solus-toolbox.ts` as a grouping/export surface, not a profile registry:

```ts
export const solusToolbox = {
  works: {
    list: listWorksTool,
    search: searchWorksTool,
    read: readWorkTool,
    create: createWorkTool,
    update: updateWorkTool,
  },
  artifact: { render: renderArtifactTool },
  automations: { /* individual named tools */ },
  sessions: { /* individual named tools */ },
  tasks: { /* individual named tools */ },
  prs: { /* individual named tools */ },
}
```

Services may use arrays such as `Object.values(solusToolbox.works)` locally,
but do not add `interactiveTools`, `automationTools`, or similarly named
pre-composed profiles to the toolbox module.

**Verify**:

- `bun test tests/unit/agent-toolbox.test.ts` passes.
- The test asserts unique names and exact parity with the current full Codex
  schema name set before compatibility exports are removed.

### Step 3: Implement the Claude and Codex tool adapters

#### Claude

`claude-tool-adapter.ts` must:

1. Turn exactly the selected `AgentTool[]` into one in-process `solus` MCP
   server using `tool()` and `createSdkMcpServer()`.
2. Validate through the neutral Zod shape and call `AgentTool.execute`.
3. Serialize `{ ok, text }` into Claude content/isError.
4. Produce allowed MCP names only for selected tools that are pre-approved
   under the current permission mode. Approval-required tools in interactive
   ask mode remain registered but fall through to the existing permission
   responder.
5. Leave current provider-native `SAFE_TOOLS`, filesystem, shell, and web
   behavior inside the Claude adapter/backend. They are not `AgentTool`s.

#### Codex

`codex-tool-adapter.ts` must:

1. Turn exactly the selected `AgentTool[]` into Codex dynamic-tool descriptors.
2. Route `item/tool/call` by normalized bare tool name to the selected tool map.
3. Reject unselected/unknown tools.
4. Validate arguments through the neutral Zod shape.
5. Route approval-required tools through the existing Codex permission
   responder in ask mode.
6. Serialize the neutral result into the Codex response shape.

Keep provider-prefix stripping (`server.tool` to `tool`) in the Codex adapter.
Do not keep domain classification or a switch over tool families.

Wire both backends to these adapters while leaving the compatibility exports
in place for remaining utility callers.

**Verify**:

- Adapter unit tests pass.
- Add a parity test proving the same selected two-tool array produces exactly
  those two Claude MCP names and exactly those two Codex descriptors.
- `rg -n "WORK_TOOL_NAMES|AUTOMATION_TOOL_NAMES|SESSION_TOOL_NAMES|TASK_TOOL_NAMES|PR_TOOL_NAMES" src/main/agents` returns no backend usage.

### Step 4: Add the internal `AgentRunner`

Implement `AgentRunner` over the existing backend map as a private
control-plane dependency, not an application service that leaf callers can
inject or construct.

Responsibilities:

- resolve the selected provider;
- reject duplicate tool names;
- pass only the caller-composed `prompt` and `systemPrompt`; do not inspect
  Solus settings, review state, git state, or session snapshots;
- apply a caller timeout with `AbortController`;
- start/resume/fork through the provider backend;
- expose fresh session initialization as `sessionId`;
- deliver normalized events to `request.onEvent`;
- collect the final top-level assistant output once;
- return tool-call count, permission denials, exit code, and signal;
- detach timers/listeners in `finally`;
- provide idempotent cancellation.

Change `AgentBackend.startRun` to accept one main-process `AgentRunRequest`
instead of `SessionRunInput` plus `PromptOptions`. Keep history, plan loading,
steering, and permission responder methods on `AgentBackend`; they remain
session/provider services used by `ControlPlane`.

Provider behavior:

- `persistence: 'session'` preserves provider conversation history,
  session-index refresh, and global backend events consumed by `ControlPlane`;
  ControlPlane lifecycle hooks preserve snapshots separately.
- `persistence: 'ephemeral'` does not write session index/snapshots/history and
  sends events only to the run-scoped callback. It must not create
  `ControlPlane.activeSessions` entries.
- Both modes execute through the same Claude/Codex start/turn/normalizer/tool
  implementation. Do not retain a second raw app-server loop.

Move prompt enrichment out of provider backends. Extract the existing
`system-hint.ts` composition into a provider-neutral prompt composer invoked by
`ControlPlane` and the relevant leaf services before
`ControlPlane.runAgent()`.
Provider backends receive the finished system prompt and may only add
provider-required protocol framing, never Solus feature guidance.

Move changed-file/snapshot ownership out of the request and provider adapters:

- `ControlPlane` seeds and retains `session.sessionChangedFiles`;
- normalized file-change/tool events update that ControlPlane-owned state;
- session snapshot hooks read that state directly at lifecycle boundaries;
- ephemeral callers that need snapshots own equivalent local state outside
  `AgentRunRequest`;
- characterize current Claude and Codex snapshot behavior before moving it so
  the refactor does not change recovery or changed-file attribution.

Wire construction in `boot-core.ts`:

```ts
const backends = createBackends()
const agentRunner = new AgentRunner(backends)
const controlPlane = new ControlPlane(backends, agentRunner)
```

Do not export the runner instance from boot wiring or pass it to any feature
service. `ControlPlane` is its only caller.

Update the E2E mock backend registry and control-plane unit setup to implement
the new request signature.

**Verify**:

- `bun test tests/unit/agent-runner.test.ts` passes for both fake providers.
- Tests cover timeout, cancellation before session init, cancellation after
  init, final-output precedence, error propagation, and listener cleanup.
- `rg -n "new ClaudeAgent\\(|getCodexAppServerClient\\(" src/main --glob '*.ts'`
  reports only provider adapter/backend infrastructure, not utility services.

### Step 5: Make `ControlPlane.runAgent()` the only application dispatch API

Add a public, tab-optional `runAgent(request: AgentRunRequest): AgentRun` method
to `ControlPlane`. It must earn the boundary rather than merely forward:

- validate the stateless request and selected tool-name uniqueness;
- reject unavailable providers before starting;
- register every active run so application shutdown can cancel it;
- attach/detach run-scoped event delivery and diagnostics;
- delegate provider mechanics to the private `AgentRunner`;
- return the same lifecycle for session-backed and ephemeral callers;
- never create a tab, queue entry, or durable Solus session unless the
  session-oriented caller explicitly requested that lifecycle.

Expose a narrow structural `AgentDispatcher` interface containing only
`runAgent()`. Feature services depend on that interface, and boot wiring passes
the `ControlPlane` instance. This keeps them testable without granting access
to session/tab mutation APIs.

`runTurn()` remains the session-aware API for queue/steer/rate-limit behavior,
but its actual provider start in `_launchRun` must call
`this.runAgent(request)`. Ephemeral services call `runAgent()` directly. Thus
there are two lifecycle APIs but only one execution/dispatch path:

```text
session caller  -> runTurn() -> session policy -> runAgent()
utility caller -------------------------------> runAgent()
```

In `_launchRun`, use `SessionRunInput` and `PromptOptions` to resolve
ControlPlane-owned state and compose one stateless `AgentRunRequest`:

- provider/session/fork identity;
- resolved cwd and additional directories (not the git checkout object);
- model/reasoning/context window/fast mode;
- permission mode;
- images/max turns/max budget;
- one finished system prompt containing the applicable app, model, and
  PR-review guidance;
- persistence set to `session`.

Do not copy `gitContext`, `sessionChangedFiles`, `prReview`,
`extraInstructions`, or `modelInstructions` into the run request. The first
two remain ControlPlane state. The latter three are inputs to prompt
composition and disappear as separate values at the runner boundary.

The control plane explicitly constructs its selected tools:

- Normal interactive/create-session runs select the complete current Solus
  toolbox plus the opposite-provider subagent tool.
- `startAutomationSession` selects the same list minus every automation tool.
- Cross-provider subagent tool factories receive the narrow control-plane
  dispatcher through dependency injection; their child runs select the
  non-automation toolbox and omit both subagent tools.

Do not infer tool selection from `PromptOptions.via`, permission mode, or
session status inside `AgentRunner`. The control-plane method or feature
service starting the run must provide the array.

After every control-plane caller is explicit, remove
`SessionRunInput.toolProfile` from `src/shared/types.ts` and update the existing
automation test to assert selected tool names instead.

**Verify**:

```sh
bun test tests/unit/control-plane-agent-dispatch.test.ts
bun test tests/unit/control-plane-device-tabs.test.ts -t "headless"
bun test tests/unit/control-plane-device-tabs.test.ts -t "automation"
bun test tests/unit/automation-run-cwd.test.ts
```

Expected: all matched tests pass, and an automation assertion proves no
automation tool name is selected.

Also assert that ephemeral dispatch is present in the control plane's active-run
registry while running, is removed on settlement, and never enters
`activeSessions`, `tabs`, or the session queue.

### Step 6: Route every utility service through the control plane

#### Text generation

Make `TextGenerator` accept the narrow `AgentDispatcher` implemented by
`ControlPlane`. Its request must use:

- `tools: []`;
- `persistence: 'ephemeral'`;
- existing model/reasoning/system prompt/additional directory/max-turn values;
- existing timeout default and caller overrides;
- a permission mode that preserves the current no-write behavior.

Delete both provider branches and model-specific event listeners from
`text-generator.ts`. Keep only domain defaults and final string extraction.
For worktree naming initiated inside `ControlPlane`, call `this.runAgent()`
through the same text-generation logic; re-entrant ephemeral dispatch must not
touch the parent session lifecycle. Inject the control-plane dispatcher into
`registerWorktreeHandlers`; remove module-level `new TextGenerator()` instances.

#### Review guide

Replace both provider branches in `review-agent.ts` with one
`dispatcher.runAgent()` call.
Create the neutral `submit_review_guide` tool in `review-guide-tool.ts`; its
`execute` closure validates/captures the guide and triggers the existing
`writing` progress callback.

The review request uses:

- only the submit-guide Solus tool;
- `persistence: 'ephemeral'`;
- plan/read-only provider behavior;
- the existing prompt/model/reasoning/cancellation values.

Remove thread-id-indexed Codex capture state after no caller needs it.

#### Cross-provider subagents

Change both subagent tool implementations into neutral tool factories. Their
executors call the injected control-plane dispatcher, select the explicit
non-automation toolbox, omit both subagent tools, preserve read-only behavior,
and forward the same transcript-event subset with `parentToolUseId`.

Do not allow a child subagent to inherit its parent's selected tool array
implicitly.

**Verify**:

```sh
bun test tests/unit/text-generator.test.ts
bun test tests/unit/review-agent-control-plane.test.ts
bun test tests/unit/cross-provider-subagent-control-plane.test.ts
bun test tests/unit/codex-subagent-event-bridge.test.ts tests/unit/session-event-subagent.test.ts
```

Expected: all pass for both providers.

### Step 7: Delete compatibility and one-shot paths

Only after Steps 1-6 are green:

1. Delete `codex-oneshot.ts`.
2. Delete `codex-solus-tools.ts`.
3. Remove `ClaudeAgent.runOneShot()` if it has no callers; do not keep an unused
   convenience API.
4. Remove provider-specific SDK tool builders and JSON descriptor arrays from
   domain modules.
5. Remove `*_TOOL_NAMES`, `*_MUTATING_TOOLS`, and Codex review capture maps.
6. Remove old comments describing three tool shapes or headless one-shot
   routing.
7. Remove `registerHeadlessThread`/`unregisterHeadlessThread` only if no
   remaining app-server path uses them.
8. Delete `codex-oneshot.test.ts` only after its behavioral cases have moved to
   `agent-runner.test.ts`.

Use `rg` to prove there is one path:

```sh
rg -n "runCodexOneShot|runOneShot|codexSolusToolSchemas|executeCodexSolusTool|createSolusMcpServer|TOOL_JSON_SCHEMAS|TOOL_NAMES|MUTATING_TOOLS|toolProfile" src tests
```

Expected: zero matches, except unrelated third-party/generated identifiers if
any are documented in the plan completion note.

### Step 8: Run final verification and inspect scope

Run the focused regression suite and build. Then inspect the diff for:

- raw provider types outside provider folders;
- services selecting tools by explicit array;
- no named profiles;
- no provider-specific tool schema duplication;
- no module-level runner/provider construction in services;
- no behavior changes to queueing, automations, reviews, or session history.

**Verify**:

```sh
bun test tests/unit/agent-toolbox.test.ts tests/unit/agent-tool-adapters.test.ts tests/unit/agent-runner.test.ts tests/unit/control-plane-agent-dispatch.test.ts tests/unit/text-generator.test.ts tests/unit/review-agent-control-plane.test.ts tests/unit/cross-provider-subagent-control-plane.test.ts
bun test tests/unit/control-plane-device-tabs.test.ts tests/unit/session-tools-search.test.ts tests/unit/codex-subagent-event-bridge.test.ts tests/unit/session-event-subagent.test.ts tests/unit/automation-run-cwd.test.ts
bun run build
git status --short
```

Expected: all new tests pass, focused existing tests have no regression from
the recorded baseline, build exits 0, and only in-scope source/test/plan files
are modified.

## Test plan

### Toolbox and adapters

- Every current Solus tool appears once in the toolbox.
- Tool names are globally unique.
- Claude and Codex expose exactly the selected subset.
- Both providers validate the same Zod shape.
- Unknown and unselected tools fail without invoking an executor.
- `{ ok: false }` becomes the provider's error-tool result.
- Approval-required metadata produces current ask/auto/plan behavior.
- Domain side-effect events are unchanged.

### Runner

- Claude and Codex return the same `AgentRunResult` shape.
- Final assembled assistant output wins over partial chunks.
- No-output completion returns an empty string.
- Timeout aborts once and releases listeners/timers.
- Parent cancellation interrupts child subagent runs.
- Ephemeral runs do not index/persist sessions.
- Session runs still initialize, persist, resume, fork, steer, and attach tabs.
- Concurrent Codex runs route notifications/tool calls by thread/turn id.

### Service selections

- Text: zero Solus tools.
- Review: only `submit_review_guide`.
- Interactive: exact current full toolbox plus opposite-provider subagent.
- Automation: exact current toolbox minus automation tools.
- Subagent: exact non-automation toolbox with no nested subagent tools.
- Selection does not depend on a string profile or provider.

### Regression

- Automation final output continues to land in its run record.
- Review progress changes to `writing` when the submit tool is called.
- Nested transcript events keep the correct `parentToolUseId`.
- Work/task/session/automation/artifact cards still emit in interactive runs.
- Branch-name, commit-message, and PR-text generation preserve timeouts and
  output parsing.
- A contract test rejects feature-state fields on `AgentRunRequest`, and prompt
  composition tests prove app/model/review guidance reaches `systemPrompt`.
- Claude and Codex snapshot tests prove changed-file continuity without
  passing `sessionChangedFiles` through `AgentRunRequest`.

## Done criteria

- [ ] `AgentTool` is the only source of Solus tool schema, approval metadata,
  and execution.
- [ ] Each service passes an explicit `AgentTool[]`; no named run-profile
  registry exists.
- [ ] Claude and Codex adapters compile the same selected tools.
- [ ] Provider-native capabilities are absent from the neutral contract.
- [ ] `AgentRunRequest` contains no Solus feature objects or durable session
  state; review/settings guidance is already composed into its prompt fields.
- [ ] Git checkout and changed-file/snapshot state remain owned by
  `ControlPlane` or the originating service.
- [ ] `ControlPlane.runAgent()` is the only application-facing agent execution
  entry; no feature service has direct access to `AgentRunner` or a provider.
- [ ] The internal `AgentRunner` is called only by `ControlPlane`.
- [ ] Session work and ephemeral utility work share that dispatch boundary,
  while session/tab/queue ownership remains optional and ControlPlane-owned.
- [ ] Text, review, automation, interactive, and subagent tool selections match
  their characterization tests.
- [ ] `codex-oneshot.ts` and `codex-solus-tools.ts` are deleted.
- [ ] `ClaudeAgent.runOneShot()` and `SessionRunInput.toolProfile` are removed.
- [ ] No utility service directly constructs `ClaudeAgent` or subscribes to the
  raw Codex client.
- [ ] New toolbox, adapter, runner, and service-selection tests pass.
- [ ] Focused regression tests show no new failures.
- [ ] `bun run build` exits 0.
- [ ] No out-of-scope files are modified.
- [ ] `plans/README.md` marks Plan 005 DONE.

## STOP conditions

Stop and report instead of improvising if:

- Plans 003 or 004 have not landed and their live changes conflict with
  `AgentBackend`, `ControlPlane`, or provider run lifecycle code.
- A selected Solus tool cannot be represented by one Zod shape and one neutral
  `{ ok, text }` executor without exposing provider SDK types.
- A provider-native tool must be added to `AgentRunRequest` to make the
  refactor work. That contradicts the approved architecture.
- A Solus feature object or session bookkeeping field must be added to
  `AgentRunRequest`. Keep it in the owning service and pass only its resolved
  execution effect (for example `cwd` or composed `systemPrompt`).
- Ephemeral execution cannot reuse a provider backend without writing session
  history/index state. Report the concrete provider limitation before adding a
  second runner.
- Codex notifications without thread/turn identity make concurrent run-scoped
  routing ambiguous. Do not restore a global “only active run” guess.
- A service requires tools outside the explicit selections documented above.
- Preserving tool permission behavior requires changing product policy rather
  than translating existing behavior.
- The refactor requires changing shared RPC payloads or renderer APIs.
- A verification step fails twice after a reasonable scoped correction.

## Maintenance notes

- A new Solus tool should be added once as an `AgentTool`, then selected by the
  services that need it. Reviewers should reject provider-specific copies of
  its schema or executor.
- Tool availability and authorization remain separate: selection controls
  whether a tool exists; `requiresApproval` plus permission mode controls
  whether a selected call needs approval.
- Recursion protection must remain visible in service-owned arrays. When adding
  an automation or subagent tool, review automation and child-subagent
  selections explicitly.
- Provider-native built-ins remain adapter implementation details. Revisit that
  decision only through a separate architecture plan.
- The highest-risk review areas are concurrent Codex routing, cancellation
  listener cleanup, session persistence parity, and accidental expansion of
  unattended tool access.
