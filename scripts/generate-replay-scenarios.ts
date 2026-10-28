/**
 * Writes the replay scenarios that come from recorded provider streams
 * (docs/replay-provider.md). Each source is a raw Claude or Codex stream from
 * tests/unit/__fixtures__, run once through the real event normalizer, so the
 * scenario holds exactly the events Solus produced for it.
 *
 *   bun scripts/generate-replay-scenarios.ts          write the scenarios
 *   bun scripts/generate-replay-scenarios.ts --check  fail when one is stale
 *
 * `showcase.ndjson` is written by hand and is not touched here.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { NormalizedEvent } from '@solus/contracts/types'

// The normalizers are pure, but their module graph reaches the database module.
// This script opens no database: a stub stands in for `node:sqlite`, which Bun
// lacks, and the data folder is a fresh temporary one.
process.env.SOLUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'solus-replay-generate-'))
process.env.SOLUS_DEV_LOG ??= join(process.env.SOLUS_DATA_DIR, 'dev.log')
Bun.plugin({ setup(build) { build.module('node:sqlite', () => ({ exports: { DatabaseSync: class {} }, loader: 'object' })) } })

const { ClaudeTurnNormalizer } = await import('@solus/server/execution/agents/claude/claude-event-normalizer')
const { CodexTurnNormalizer } = await import('@solus/server/execution/agents/codex/codex-event-normalizer')
const { isReplayableEventType, parseReplayScenario } = await import('@solus/server/execution/agents/replay/replay-scenario')

const ROOT = resolve(import.meta.dir, '..')
const FIXTURES = join(ROOT, 'tests/unit/__fixtures__')
const SCENARIOS = join(ROOT, 'packages/server/src/execution/agents/replay/scenarios')
/** The checkout the fixtures were recorded in; it becomes the live workspace. */
const RECORDED_WORKSPACE = '/Users/sidhu/solus'

interface DerivedScenario {
  id: string
  label: string
  source: string
  /** The source's lines, each one raw event of the provider's stream. */
  normalize(lines: string[]): NormalizedEvent[]
}

const DERIVED: DerivedScenario[] = [
  {
    id: 'subagent',
    label: 'Background sub-agent',
    source: 'claude-async-subagent.jsonl',
    normalize: (lines) => { const normalizer = new ClaudeTurnNormalizer(); return lines.flatMap((line) => normalizer.push(JSON.parse(line))) },
  },
  {
    id: 'codex-plan',
    label: 'Codex plan mode',
    source: 'codex-plan-mode.jsonl',
    normalize: (lines) => { const normalizer = new CodexTurnNormalizer({ planMode: true }); return lines.flatMap((line) => normalizer.push(JSON.parse(line))) },
  },
  {
    id: 'codex-command',
    label: 'Codex command',
    source: 'codex-normal-turn.jsonl',
    normalize: (lines) => { const normalizer = new CodexTurnNormalizer({ planMode: false }); return lines.flatMap((line) => normalizer.push(JSON.parse(line))) },
  },
]

function scenarioText(scenario: DerivedScenario): string {
  const lines = readFileSync(join(FIXTURES, scenario.source), 'utf8').trim().split('\n')
  // The replay backend owns the turn's start and end, so lifecycle events drop out.
  const events = scenario.normalize(lines).filter((event) => isReplayableEventType(event.type))
  const entries = [
    JSON.stringify({ kind: 'scenario', label: scenario.label }),
    JSON.stringify({ kind: 'turn' }),
    ...events.map((event) => JSON.stringify({ kind: 'event', event }).replaceAll(RECORDED_WORKSPACE, '<workspace>')),
  ]
  const text = `${entries.join('\n')}\n`
  parseReplayScenario(scenario.id, text)
  return text
}

const check = process.argv.includes('--check')
let stale = 0
for (const scenario of DERIVED) {
  const file = join(SCENARIOS, `${scenario.id}.ndjson`)
  const text = scenarioText(scenario)
  if (!check) {
    writeFileSync(file, text)
    console.log(`wrote ${scenario.id}.ndjson from ${scenario.source}`)
    continue
  }
  let current = ''
  try { current = readFileSync(file, 'utf8') } catch {}
  if (current !== text) {
    stale++
    console.error(`${scenario.id}.ndjson is stale. Run bun scripts/generate-replay-scenarios.ts.`)
  }
}
process.exitCode = stale > 0 ? 1 : 0
