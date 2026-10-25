import { describe, expect, test } from 'bun:test'
import {
  buildRemoteDispatchCard,
  mergeRemoteDispatchProgress,
} from '@solus/workspace-ui/lib/remote-dispatch-card'

describe('remote dispatch conversation card', () => {
  test('shows host-owned repository preparation as a session startup stage', () => {
    const card = buildRemoteDispatchCard({
      tabId: 'tab-1',
      hostLabel: 'Studio',
      phase: 'repository',
    })

    expect(card.title).toBe('Starting on Studio')
    expect(card.steps.map((step) => [step.id, step.status])).toEqual([
      ['connection', 'done'],
      ['repository', 'active'],
      ['fetch', 'pending'],
      ['checkout', 'pending'],
      ['submodules', 'pending'],
      ['agent', 'pending'],
    ])
  })

  test('keeps actionable connection errors on the failed step', () => {
    const card = buildRemoteDispatchCard({
      tabId: 'tab-1',
      hostLabel: 'Studio',
      phase: 'connecting',
      error: { step: 'connection', message: 'Host authentication expired.' },
    })

    expect(card.status).toBe('error')
    expect(card.steps[0]).toMatchObject({
      status: 'error',
      detail: 'Host authentication expired.',
    })
  })

  test('the host copying the repository takes over the repository step', () => {
    // WHY: the host now reports the clone on its own card, with its progress
    // and its errors. A second, client-side repository step would say the
    // copy is done while the host is still making it.
    const waiting = buildRemoteDispatchCard({ tabId: 'tab-1', hostLabel: 'Studio', phase: 'repository' })
    const merged = mergeRemoteDispatchProgress(waiting, {
      id: 'worktree-session-1',
      title: 'Repository setup failed',
      icon: 'git-branch',
      status: 'error',
      recovery: 'connect-github',
      recoveryUrl: 'https://app.solus.sh/connections',
      steps: [
        { id: 'repository', label: 'Preparing repository', status: 'error', detail: 'GitHub is not connected.' },
        { id: 'fetch', label: 'Fetch base branch', status: 'pending' },
        { id: 'checkout', label: 'Check out files', status: 'pending' },
        { id: 'submodules', label: 'Init submodules', status: 'pending' },
        { id: 'agent', label: 'Start agent', status: 'pending' },
      ],
    })
    expect(merged.steps.map((step) => [step.id, step.status])).toEqual([
      ['connection', 'done'],
      ['repository', 'error'],
      ['fetch', 'pending'],
      ['checkout', 'pending'],
      ['submodules', 'pending'],
      ['agent', 'pending'],
    ])
    expect(merged).toMatchObject({ title: 'Repository setup failed', status: 'error', recovery: 'connect-github', recoveryUrl: 'https://app.solus.sh/connections' })
  })

  test('preserves preparation steps when backend worktree progress begins', () => {
    const prepared = buildRemoteDispatchCard({
      tabId: 'tab-1',
      hostLabel: 'Studio',
      phase: 'ready',
    })
    const merged = mergeRemoteDispatchProgress(prepared, {
      id: 'worktree-tab-1',
      title: 'Preparing worktree…',
      icon: 'git-branch',
      status: 'active',
      steps: [
        { id: 'fetch', label: 'Fetch base branch', status: 'active' },
        { id: 'checkout', label: 'Check out files', status: 'pending' },
        { id: 'submodules', label: 'Init submodules', status: 'pending' },
        { id: 'agent', label: 'Start agent', status: 'pending' },
      ],
    })

    expect(merged.id).toBe('remote-dispatch-tab-1')
    expect(merged.title).toBe('Starting on Studio')
    expect(merged.steps.map((step) => step.id)).toEqual([
      'connection',
      'repository',
      'fetch',
      'checkout',
      'submodules',
      'agent',
    ])
  })
})
