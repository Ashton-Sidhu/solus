import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { registerStackHandlers } from '../../src/main/server/handlers/stack-handlers'
import type { SolusServer } from '../../src/main/server/server'
import type { IpcContext } from '../../src/shared/types'
import { ClientEventRegistry } from '../../src/main/events/client-event-registry'
import { HostEventPublisher } from '../../src/main/events/host-event-publisher'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function context(cwd: string, stackedPrsEnabled: boolean): IpcContext {
  return {
    session: { workingDirectory: cwd },
    settings: { stackedPrsEnabled },
  } as unknown as IpcContext
}

describe('stacked pull request settings gate', () => {
  test('hides a cached lineage graph while the experimental flag is off', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'solus-stack-settings-'))
    temporaryDirectories.push(cwd)
    expect(spawnSync('git', ['init'], { cwd }).status).toBe(0)
    mkdirSync(join(cwd, '.solus'))
    writeFileSync(join(cwd, '.solus', 'stacks.json'), JSON.stringify({
      edges: [{ parent: 10, child: 11, source: 'ancestry' }],
      headShas: { 10: 'parent', 11: 'child' },
      detectedAt: '2026-07-31T00:00:00.000Z',
    }))

    const handlers = new Map<string, (args: unknown[]) => unknown>()
    const server = {
      register(method: string, handler: (args: unknown[]) => unknown) {
        handlers.set(method, handler)
      },
    } as unknown as SolusServer
    registerStackHandlers(server, new HostEventPublisher(new ClientEventRegistry()))

    const stackGet = handlers.get('stackGet')!
    const disabled = await stackGet([context(cwd, false)]) as { graph: { edges: unknown[] } }
    const enabled = await stackGet([context(cwd, true)]) as { graph: { edges: unknown[] } }

    expect(disabled.graph.edges).toEqual([])
    expect(enabled.graph.edges).toEqual([{ parent: 10, child: 11, source: 'ancestry' }])
  })
})
