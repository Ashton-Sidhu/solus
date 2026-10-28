import { describe, expect, test } from 'bun:test'
import type { SshAddProgress } from '@solus/contracts/remote-machines'
import { sshAddStatusCard, type SshAddCardInput } from '@solus/client-core/ssh-progress'

// WHY: docs/plans/host-routes.md D6. Adding a machine over SSH draws the same
// setup card as a run's setup, on every client: the install carries its
// percentage, and the result is the last step, not a screen of its own.

const event = (step: SshAddProgress['step'], message: string, percent?: number): SshAddProgress =>
  percent === undefined ? { requestId: 'r', step, message } : { requestId: 'r', step, message, percent }

const input = (standing: SshAddCardInput['standing'], overrides: Partial<SshAddCardInput> = {}): SshAddCardInput =>
  ({ target: 'me@box', standing, resultMessage: '', error: '', ...overrides })

describe('an SSH add as a setup card', () => {
  test('the running install carries its latest percentage, and Connected waits at the end', () => {
    const card = sshAddStatusCard([
      event('connect', 'Connecting to me@box'),
      event('install', 'Installing Solus on box'),
      event('install', 'Installing Solus on box', 20),
      event('install', 'Installing Solus on box', 64),
    ], input('running'))
    expect(card).toEqual({
      id: 'ssh-add:r',
      title: 'Adding me@box',
      icon: 'server',
      status: 'active',
      steps: [
        { id: 'connect', label: 'Connecting to me@box', status: 'done' },
        { id: 'install', label: 'Installing Solus on box', status: 'active', percent: 64 },
        { id: 'connected', label: 'Connected', status: 'pending' },
      ],
    })
  })

  test('a done add ends on its result as the last step, with no percentage left behind', () => {
    const card = sshAddStatusCard(
      [event('install', 'Installing Solus on box', 92), event('forward', 'Opening the SSH forward to box')],
      input('done', { resultMessage: 'box is added. This computer reaches it over SSH.' }),
    )
    expect(card.status).toBe('done')
    expect(card.steps).toEqual([
      { id: 'install', label: 'Installing Solus on box', status: 'done' },
      { id: 'forward', label: 'Opening the SSH forward to box', status: 'done' },
      { id: 'connected', label: 'box is added. This computer reaches it over SSH.', status: 'done' },
    ])
  })

  test('a failed add marks the step it stopped on with the reason, and promises no Connected', () => {
    const card = sshAddStatusCard(
      [event('connect', 'Connecting to me@box'), event('install', 'Installing Solus on box', 30)],
      input('failed', { error: 'curl: (6) Could not resolve host' }),
    )
    expect(card.status).toBe('error')
    expect(card.steps).toEqual([
      { id: 'connect', label: 'Connecting to me@box', status: 'done' },
      { id: 'install', label: 'Installing Solus on box', status: 'error', detail: 'curl: (6) Could not resolve host' },
    ])
  })
})
