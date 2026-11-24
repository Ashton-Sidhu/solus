import { describe, expect, test } from 'bun:test'
import type { SshAddProgress } from '@solus/contracts/remote-machines'
import { addMachineStatusCard, type AddMachineProgressInput } from '@solus/client-core/add-machine-progress'

// WHY: docs/plans/add-machine-card.md. An add from the Add machine card draws
// the setup card a run's setup draws, with the same steps on desktop, web, and
// mobile. A person must see which step runs, where an add stopped and why, and
// never a "Connected" that a failed add cannot reach.

const event = (step: SshAddProgress['step'], message: string, percent?: number): SshAddProgress =>
  percent === undefined ? { requestId: 'r', step, message } : { requestId: 'r', step, message, percent }

const input = (overrides: Partial<AddMachineProgressInput>): AddMachineProgressInput =>
  ({ attemptId: 'a1', way: 'ssh', name: 'Windows desktop', sshTarget: 'solus-windows', sshSteps: [], standing: 'running', error: '', ...overrides })

describe('an Add machine card as a setup card', () => {
  test('SSH: the host steps run in order under the machine name, and Connected waits at the end', () => {
    const card = addMachineStatusCard(input({ sshSteps: [event('connect', 'Connecting to solus-windows'), event('install', 'Installing Solus', 62)] }))
    expect(card).toEqual({
      id: 'add-machine:a1',
      title: 'Adding Windows desktop',
      icon: 'server',
      status: 'active',
      steps: [
        { id: 'connect', label: 'Connecting to solus-windows', status: 'done' },
        { id: 'install', label: 'Installing Solus', status: 'active', percent: 62 },
        { id: 'connected', label: 'Connected', status: 'pending' },
      ],
    })
  })

  test('SSH: an add that stops before the host reports a step still names the connect it stopped on', () => {
    const card = addMachineStatusCard(input({ standing: 'failed', error: 'ssh: connect to host 10.10.1.10 port 22: Connection refused' }))
    expect(card.status).toBe('error')
    expect(card.steps).toEqual([
      { id: 'connect', label: 'Connecting to solus-windows', status: 'error', detail: 'ssh: connect to host 10.10.1.10 port 22: Connection refused' },
    ])
  })

  test('SSH: a refused key is a warning on its step with the reason, not the end of the add', () => {
    const card = addMachineStatusCard(input({ standing: 'needs-auth', sshSteps: [event('connect', 'Connecting to solus-windows')], error: 'SSH refused the key.' }))
    expect(card.steps).toEqual([{ id: 'connect', label: 'Connecting to solus-windows', status: 'warning', detail: 'SSH refused the key.' }])
  })

  test('approve: the card waits on the target, then is connected', () => {
    const waiting = addMachineStatusCard(input({ way: 'approve', name: 'studio-mac' }))
    expect(waiting.title).toBe('Adding studio-mac')
    expect(waiting.steps).toEqual([
      { id: 'approve', label: 'Waiting for approval on studio-mac', status: 'active' },
      { id: 'connected', label: 'Connected', status: 'pending' },
    ])
    const added = addMachineStatusCard(input({ way: 'approve', name: 'studio-mac', standing: 'done' }))
    expect(added.title).toBe('Added studio-mac')
    expect(added.status).toBe('done')
    expect(added.steps.every((step) => step.status === 'done')).toBe(true)
  })

  test('code: a refused code fails its step with the reason and promises no Connected', () => {
    const card = addMachineStatusCard(input({ way: 'code', name: 'nas', standing: 'failed', error: 'The host did not accept the pairing code.' }))
    expect(card.steps).toEqual([{ id: 'pair', label: 'Pairing with nas', status: 'error', detail: 'The host did not accept the pairing code.' }])
  })
})
