import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { RunLogLine, RunProjectStatus } from '../../src/shared/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousWindow = globalThis.window
let RunStore: typeof import('../../src/renderer/contexts/run/run.store.svelte')['RunStore']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ RunStore } = await import('../../src/renderer/contexts/run/run.store.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
})

describe('run log subscription retention', () => {
  test('does not repopulate a released buffer from a late backfill', async () => {
    let resolveBackfill!: (lines: RunLogLine[]) => void
    const backfill = new Promise<RunLogLine[]>((resolve) => { resolveBackfill = resolve })
    const project: RunProjectStatus = {
      repoRoot: '/repo',
      runs: [{ commandId: 'dev', repoRoot: '/repo', state: 'running' }],
    } as RunProjectStatus
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        solus: {
          runStatus: async () => project,
          runLogs: async () => backfill,
          onRunLog: () => () => {},
        },
      },
    })
    const store = new RunStore()
    await store.status('/repo')

    const release = store.retainLogs('/repo', '/repo', 'dev')
    release()
    resolveBackfill([{ seq: 0, ts: 1, level: 'info', text: 'late' }])
    await backfill
    await Promise.resolve()

    expect(store.logsFor('/repo', 'dev')).toBeUndefined()
  })
})
