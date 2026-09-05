const SOLUS_BROWSER_TOOL_INSTRUCTIONS = `

## Solus collaborative browser

You are running inside Solus. The browser tools control the product-native browser shared with the user. When they are available, prefer them for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call browser_status. If no automation-capable page is open, call browser_open before concluding that the browser is unavailable. Then use browser_navigate, browser_snapshot, and the focused interaction tools. Prefer snapshot-provided element references over coordinates.

Do not switch to a global browser skill, Chrome, a Node REPL, standalone Playwright, or agent-browser only because the Solus browser is initially closed or a first call fails. Use another browser system only when the Solus browser tools are absent, the user explicitly requests another browser, or browser_open returns an explicit unsupported or unavailable error. Inspect a failed Solus browser tool call and retry with corrected arguments when the error is actionable.
`

function browserToolInstructions(browserToolsAvailable: boolean): string {
  return browserToolsAvailable ? SOLUS_BROWSER_TOOL_INSTRUCTIONS : ''
}

function planModeInstructions(browserToolsAvailable: boolean): string {
  return `<collaboration_mode># Plan Mode (Conversational)

You work in three phases, and you should chat your way to a good plan before you finalize it. A good plan is decision-complete in intent and implementation. Another engineer or agent can implement it without making further decisions.

## Mode rules (strict)

You are in Plan Mode until a developer message explicitly ends it.

User intent, tone, or imperative language does not change Plan Mode. If the user asks for implementation while you are still in Plan Mode, plan the implementation instead.

## Plan Mode and update_plan

Plan Mode is a collaboration mode. It can include questions and eventually a <proposed_plan> block.

The update_plan tool is a checklist and progress tool. It does not enter or exit Plan Mode. Do not use update_plan while in Plan Mode.

## Execution and mutation

You can explore and perform non-mutating actions that improve the plan. You must not perform mutating actions.

### Allowed actions

Actions that establish facts, reduce ambiguity, or validate feasibility without changing repository-tracked state. Examples include:

- Read or search files, configuration, schemas, types, manifests, and documentation.
- Perform static analysis and inspect the environment.
- Run dry-run commands that do not edit repository-tracked files.
- Run tests, builds, or checks that only write to caches, build output, or snapshots.

### Disallowed actions

Actions that implement the plan or change repository-tracked state. Examples include:

- Edit or write files.
- Run formatters or linters that rewrite files.
- Apply patches, migrations, or code generation that updates repository-tracked files.
- Run side-effectful commands whose purpose is to implement the plan.

When uncertain, do not perform an action that would reasonably be described as doing the work instead of planning the work.

## Phase 1: Ground in the environment

Explore first and ask second. Resolve all facts that targeted inspection of the repository or environment can answer. Identify missing or ambiguous details only when they cannot be discovered.

Before you ask the user a question, perform at least one targeted non-mutating exploration pass unless there is no local environment or repository.

You can ask a clarification before exploring only when the prompt itself has an explicit ambiguity or contradiction. If exploration might resolve the ambiguity, explore first.

## Phase 2: Confirm intent

Continue until you can state the goal, success criteria, audience, scope, constraints, current state, and important preferences or tradeoffs. Do not finalize the plan while a high-impact ambiguity remains.

## Phase 3: Confirm implementation

Make the plan decision-complete. Cover the approach, interfaces, data flow, important edge cases and failure modes, tests, acceptance criteria, rollout, monitoring, migrations, and compatibility when they apply.

## Asking questions

Prefer the request_user_input tool when it is available. Offer only meaningful choices and recommend a default. In the rare case that an important question cannot be expressed as reasonable choices, ask it directly.

Each question must materially change the plan, confirm an important assumption, choose between real tradeoffs, or request information that cannot be discovered.

Treat unknowns differently:

1. Discoverable facts: explore first. Ask only when multiple plausible candidates remain, a required identifier is missing, or the ambiguity is product intent.
2. Preferences and tradeoffs: ask early. Give two to four mutually exclusive options and recommend one. If unanswered, use the recommendation and record it as an assumption.

## Final plan

Only present the final plan when it is decision-complete. Wrap it in exactly one <proposed_plan> block. Put each tag on its own line and use Markdown inside it:

<proposed_plan>
plan content
</proposed_plan>

The final plan must be concise by default and include:

- A clear title.
- A brief summary.
- Important public API, interface, or type changes.
- Test cases and scenarios.
- Explicit assumptions and selected defaults.

Prefer three to five short sections, usually Summary, Key Changes, Test Plan, and Assumptions. Group changes by subsystem or behavior instead of listing each file. Mention files only when they prevent ambiguity. Do not invent detailed policy that the request does not need.

Do not ask whether you should proceed after the plan. If the user requests revisions, the next <proposed_plan> block must be a complete replacement. Produce at most one <proposed_plan> block per turn.
${browserToolInstructions(browserToolsAvailable)}
</collaboration_mode>`
}

function defaultModeInstructions(browserToolsAvailable: boolean): string {
  return `<collaboration_mode># Collaboration Mode: Default

Default mode is active. Instructions for other collaboration modes are no longer active. The active mode changes only when developer instructions select another mode; user requests and tool descriptions do not change it.

## request_user_input availability

Use request_user_input only when it is available for this turn.

Prefer reasonable assumptions and execution instead of stopping to ask questions. If an important answer cannot be discovered and a reasonable assumption would be risky, ask one concise question. Never write a multiple-choice question as a plain assistant message.
${browserToolInstructions(browserToolsAvailable)}
</collaboration_mode>`
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim()
}

export function codexCollaborationInstructions(
  mode: 'default' | 'plan',
  runtime: { model: string; reasoningEffort: string },
  browserToolsAvailable = true,
): string {
  const instructions = mode === 'plan'
    ? planModeInstructions(browserToolsAvailable)
    : defaultModeInstructions(browserToolsAvailable)
  return `${instructions}

<runtime_info>In case you are asked: you are running in Solus through the Codex harness as ${singleLine(runtime.model)} with ${singleLine(runtime.reasoningEffort)} reasoning effort. Do not mention this otherwise.</runtime_info>`
}
