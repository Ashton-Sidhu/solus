# Replay provider (development only)

Real agent turns cost money and take time. The **Replay (dev)** provider is a free agent that plays recorded turns, with simulated streaming, through the real Solus pipeline: the session runtime, provider events, the transcript, and every client. Use it to watch a turn render while you change the UI. Use a real provider only when the change depends on that provider's behavior, and then its cheapest model.

It follows t3code's replay provider (pingdotgg/t3code#26207), adapted to Solus: an in-process `AgentBackend` that emits Solus `NormalizedEvent`s, instead of a separate ACP agent process.

## Start a replay

On desktop (run from source), web, and mobile:

1. Open the agent and model picker in the composer.
2. Pick the agent **Replay (dev)** and a scenario as the model. **Showcase** is the default.
3. Send any prompt. Each prompt plays the scenario's next turn, and the scenario starts again after its last turn.

Headless, run the standalone server as `.claude/skills/run-app/SKILL.md` describes and drive the same picker with Playwright. Mobile has no extra UI: the picker lists the scenarios that the host reports.

## What a replay does

- A new session gets a random provider session id. A resumed session keeps its id and continues at its next turn. Each session keeps its own place in its scenario; changing the scenario starts it from its first turn.
- Text streams in chunks of about three words, 30 ms apart. Other events come 250 ms apart. A recorded `afterMs` replaces that wait, up to 2 s.
- A permission request waits for the user's answer. Allow continues the turn. Deny fails the tool, as a provider reports a declined call, and ends the turn. A plan with options waits the same way; a denied plan stops the turn.
- A question waits for its answer, then the turn continues.
- Stop ends the turn as interrupted, without a result.
- A turn that ends writes the session's history to `<data folder>/replay-sessions/<session id>.json`, so a reopened session shows its earlier turns.
- An unknown scenario fails the run with an error that lists the scenarios. There is no fallback.
- The permission mode and the reasoning effort change nothing: a replay asks what its recording asks.

## Scenarios

The scenarios are in `packages/server/src/execution/agents/replay/scenarios/`. The file name is the model id.

| Model | Label | Source |
| --- | --- | --- |
| `showcase` | Showcase | Written by hand. Turn 1: thinking, a to-do plan, a file read, an edit that asks permission (with its diff), a test run with output, and a markdown answer with a code block and a table. Turn 2: a question to the user, then an answer. |
| `subagent` | Background sub-agent | `tests/unit/__fixtures__/claude-async-subagent.jsonl` through the Claude normalizer. |
| `codex-plan` | Codex plan mode | `tests/unit/__fixtures__/codex-plan-mode.jsonl` through the Codex normalizer in plan mode. |
| `codex-command` | Codex command | `tests/unit/__fixtures__/codex-normal-turn.jsonl` through the Codex normalizer. |

Rate limits are not replayed: a recorded `rate_limit` would park a real session on a reset time that has already passed.

### File format

NDJSON, one entry per line:

```json
{"kind":"scenario","label":"Showcase"}
{"kind":"turn"}
{"kind":"event","event":{"type":"text_chunk","text":"Hello."}}
{"kind":"event","event":{"type":"tool_call","toolName":"Read","toolId":"read-1","index":0},"afterMs":400}
```

- The first line names the scenario's label in the picker.
- `{"kind":"turn"}` starts the turn that the next prompt plays.
- Each event is one `NormalizedEvent` (`packages/contracts/src/types.ts`). `afterMs` is optional.
- The backend owns the turn's start and end, so a file cannot hold `session_init`, `task_complete`, errors, rate limits, or status. The parser names the line that breaks this rule.
- `<workspace>` in any string becomes the session's working directory. Tool, task, plan, and request ids get a prefix for each play, so a replayed turn adds new rows.

### Add a scenario

- **By hand:** write `<id>.ndjson` in the scenarios folder. `bun test tests/unit/replay-backend.test.ts` checks that every committed scenario parses; update the list it expects.
- **From a recorded provider stream:** add the raw Claude or Codex stream to `tests/unit/__fixtures__/`, add an entry to `DERIVED` in `scripts/generate-replay-scenarios.ts`, and run `bun scripts/generate-replay-scenarios.ts`. Commit the script change and the NDJSON it writes. `--check` fails when a generated scenario is stale.

The scenario list is read when the server starts. Restart the server to see a new one.

## The development gate

`replayBackendAllowed` in `packages/server/src/execution/agents/replay/replay-gate.ts` decides whether a process registers the backend:

| Process | Replay |
| --- | --- |
| Packaged desktop app (`app.isPackaged`) | Never |
| Released standalone server (its launcher sets `SOLUS_INSTALL_DIR`) | Never |
| No scenario folder found (only a source checkout has one) | Never |
| Desktop app run from source (`bun run dev`: Electron, not packaged) | Always, also on its own data folder |
| A server run from source in another way (the standalone server from `dist/main` or from source, the Lab, `BUILD_TARGET=test`) | Only when its data folder is not the live `~/.solus` |

The scenario files are read from disk at `<root>/packages/server/src/execution/agents/replay/scenarios`, where the root is Electron's app path or the working directory. They are not bundled, so no release build carries them. The test build's backend registry (`tests/e2e/mock/backend-registry.ts`) registers the replay backend beside the mock Claude backend under the same gate.

Replay sessions are written with the provider id `replay`. A build older than this provider cannot read such a session. Keep replay sessions on a development data folder.
