import { describe, expect, test } from 'bun:test'
import type { Integration, IntegrationFacts } from '@solus/contracts/integration-types'
import { CommandProcesses, type CommandProcessApi } from '@solus/client-core/command-processes'

// docs/plans/mcp-first-class.md §7.7: desktop, web, and mobile keep a command's
// process state by one rule. An older facts answer never lands over a newer one,
// and a failed start keeps the host's reason beside the state it reads again.

const capabilities = { prompts: false, resources: false, resourceSubscribe: false, tasks: false }
const facts = (process: IntegrationFacts['process']): IntegrationFacts => ({ era: null, instructions: null, capabilities, process })
const command: Integration = {
  id: 'files', organizationId: 'local', ownerKey: 'local:test', kind: 'stdio', slug: 'files', name: 'files', url: 'stdio:0123456789abcdef',
  auth: { kind: 'env', names: ['TOKEN'] }, launch: { command: 'npx', args: ['files-mcp'] }, disabledTools: [], createdAt: '', updatedAt: '',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function processesOn(api: Partial<CommandProcessApi>) {
  let changes = 0
  const processes = new CommandProcesses({
    api: () => api as CommandProcessApi,
    facts: new Map(),
    starting: new Set(),
    errors: new Map(),
    onChange: () => { changes += 1 },
  })
  return { processes, changes: () => changes }
}

describe('the processes of the commands of one host', () => {
  test('a read that was in flight during a start does not land over the start\'s answer', async () => {
    // WHY: desktop's tools read its facts again with no guard, so a slow
    // "stopped" answer could replace the "running" answer of a start.
    const slow = deferred<IntegrationFacts>()
    const { processes } = processesOn({
      integrationFacts: () => slow.promise,
      integrationProcessStart: async () => facts({ state: 'running' }),
    })
    const read = processes.load('files')
    expect(await processes.start('files')).toBe(true)
    slow.resolve(facts({ state: 'stopped' }))
    await read
    expect(processes.factsOf('files')?.process).toEqual({ state: 'running' })
  })

  test('a failed start keeps the host\'s reason, reads the state again, and ends', async () => {
    let onHost = facts({ state: 'stopped' })
    const { processes, changes } = processesOn({
      integrationFacts: async () => onHost,
      integrationProcessStart: async () => {
        expect(processes.isStarting('files')).toBe(true)
        onHost = facts({ state: 'failed', message: 'not installed', startFailure: 'not-installed' })
        throw new Error('`npx` is not installed on this host.')
      },
    })
    expect(await processes.start('files')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(processes.isStarting('files')).toBe(false)
    expect(processes.errorOf('files')).toBe('`npx` is not installed on this host.')
    expect(processes.factsOf('files')?.process?.startFailure).toBe('not-installed')
    // A client that renders from a snapshot hears each change.
    expect(changes()).toBeGreaterThan(2)
  })

  test('the row\'s state asks for values first, and a person without host.admin starts nothing', async () => {
    const { processes } = processesOn({ integrationFacts: async () => facts({ state: 'stopped' }) })
    await processes.load('files')
    expect(processes.statusOf(command, undefined, true)?.blockedReason).toBe('Enter the environment values first.')
    expect(processes.statusOf(command, undefined, false)?.blockedReason).toBe('Only an administrator of this host can add or change a command.')
    expect(processes.statusOf({ ...command, kind: 'mcp', url: 'https://x.example/mcp' }, undefined, true)).toBeNull()
  })

  test('a removed integration forgets its state, and its read in flight does not bring it back', async () => {
    const slow = deferred<IntegrationFacts>()
    const { processes } = processesOn({ integrationFacts: () => slow.promise })
    const read = processes.load('files')
    processes.forget('files')
    slow.resolve(facts({ state: 'running' }))
    await read
    expect(processes.factsOf('files')).toBeUndefined()
  })
})
