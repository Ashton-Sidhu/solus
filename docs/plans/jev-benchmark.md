# Benchmark the agent with and without Jev

## What is verified

The repository supports a controlled comparison: `AgentRunRequest.tools` in
`packages/server/src/agents/agent-runner.ts` accepts an explicit tool list, and
`AgentDispatcher.runAgent` can start a fresh ephemeral conversation. Both provider
adapters consume that list. This lets a benchmark remove `ask_jev` entirely for
the baseline, rather than merely asking the agent not to use it.

The tool's response includes the actual Jev model, token usage, request ID, and
elapsed milliseconds. Existing Insights turn records include total duration,
agent token usage, reported/estimated agent cost, and tool-call count. Tool events
identify Jev calls under `ask_jev` or `mcp__solus__ask_jev`.

TypeSafe also publishes a [skill-selection benchmark and harness](https://docs.typesafe.ai/cookbooks/skill_suggestion).
It compares an agent alone, an agent with TypeSafe suggestions, and an agent given
the correct skill. It provides a useful design, but tests another agent and skill
roster. Its suggestions are inserted before the agent runs. That is different from
our optional tool, where the agent must decide when to call Jev. Those published
results do not establish a benefit for Solus.

No live benchmark was run for this change. The deterministic tests verify tool
contracts and transport behavior, not model quality, call adoption, speed, or cost.
There is no ready-made Solus quality benchmark runner yet: `scripts/perf-benchmark.ts`
measures local algorithms, and the Lab exercises host behavior with mock agents.

## First experiment

Start with 30–50 fixed context-selection tasks. Include file selection, skill
selection, no-match cases, ambiguous cases, and cases that need more evidence.
Supply the same candidate text to each arm. Store expected acceptable selections
separately; do not give the labels to either agent. Include easy cases to detect
unnecessary calls.

Use two primary arms:

1. **Baseline:** the agent's usual tools, with `ask_jev` absent.
2. **Jev available:** identical prompt, tools, and configuration, plus `ask_jev`
   with its production description. Do not tell the agent it must call Jev.

An optional third arm can require a Jev call before selection. Treat it as a
diagnostic: it separates the model's usefulness from the agent's choice to use
the tool. Do not merge its scores with the production-description arm.

At the dispatcher boundary, select the tool list explicitly:

```ts
const baselineTools = normalTools.filter(tool => tool.name !== 'ask_jev')
const tools = variant === 'baseline'
  ? baselineTools
  : [...baselineTools, askJevAgentTool]

const run = dispatcher.runAgent({
  provider, model, reasoningEffort, prompt, cwd, tools,
  conversation: { kind: 'start' },
  permissionMode: 'auto', persistence: 'ephemeral', unattended: true,
  service: SPAN_SERVICES.subagents,
  onEvent: collectEvent,
})
const result = await run.done
```

This is the existing host API for a future runner, not a standalone script.
Resolve `cwd` through `resolveHomePath` first. Use a disposable data directory and
fixed fixture checkout. For context selection, omit delegation tools from **both**
arms so a baseline agent cannot reach Jev through a subagent. If delegation is
part of a later end-to-end benchmark, propagate the arm's tool restriction into
every child run; the production subagent tools currently include Jev.

Pin the agent model, reasoning effort, Jev model version, repository revision,
input corpus, and tool description revision. Use a fresh conversation per case
and alternate or randomize arm order. Repeat each case at least three times.
Record cache usage and rate-limit events; avoid comparing a cold baseline with
a warm treatment. Keep request failures and timeouts in the results.

## Measurements

| Measure | Why it matters |
| --- | --- |
| Acceptable selection rate | Did the agent choose useful context? |
| No-match precision/recall | Does the tool cause irrelevant reads? |
| Recall at a fixed read budget | For ranking, did the agent retain the needed evidence? |
| Jev call rate by task type | Does the description cause calls in useful situations? |
| Unnecessary call rate on easy cases | Does consultation add overhead without changing the answer? |
| Final task success | For later coding tasks, use hidden tests and a fixed review rubric. |
| Total wall time, p50 and p95 | Include prompt construction, Jev calls, retries, and fallback work. |
| Agent tokens plus Jev tokens and cost | Savings in agent tokens alone can hide added API cost. |
| Failures and fallback success | The optional service must not prevent task completion. |

Use fixed labels or task tests as the quality judge, not Jev's own confidence.
For ambiguous outputs, review without showing which arm produced them. Report
paired differences and uncertainty over **tasks**, since repeated runs of one
task are not independent examples. Select any confidence threshold on development
cases, then evaluate it on separate held-out cases.

## Available measurements and gaps

For normal durable turns, a read-only Insights query can retrieve measurements
for sessions named by the benchmark's case/arm manifest:

```sql
SELECT t.session_id, t.trace_id, t.model, t.duration_ms,
       t.input_tokens, t.output_tokens, t.cache_read_tokens,
       t.cost_usd, t.tool_call_count,
       (SELECT COUNT(*) FROM events e
        WHERE e.trace_id = t.trace_id AND e.kind = 'tool_call'
          AND e.tool IN ('ask_jev', 'mcp__solus__ask_jev')) AS jev_calls
FROM turns t
WHERE t.session_id IN ('baseline-session-id', 'jev-session-id');
```

Assign arms before the run. Do not infer arms from whether Jev was called:
choosing not to call it is a legitimate outcome in the Jev-available arm.

Ephemeral `AgentRunner` runs create coarse `agent_run` spans, not the same complete
`turns` records. A runner using the dispatcher recipe must measure wall time and
collect normalized usage/tool events itself. Its final result already has output,
tool-call count, exit code, and signal.

Jev usage is returned in the tool result, not added to the agent provider's
`cost_usd`. Capture every Jev result separately and price it against the actual
model's verified rates when running the benchmark. Do not treat absent cost as
zero. Failed requests may have unreported billable usage; reconcile against
provider billing for a cost claim. No prompt text or API keys are needed in the
aggregate report.

A benchmark runner, labeled corpus, and live provider runs remain future
work. The integration provides the tool and the per-call measurements needed to
build that comparison; it does not claim that Jev already improves agent outcomes.
