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
      ['worktree', 'pending'],
      ['workspace', 'pending'],
      ['session', 'pending'],
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

  test('a clone that failed for want of the account’s GitHub offers the Connections page', () => {
    const card = buildRemoteDispatchCard({
      tabId: 'tab-1',
      hostLabel: 'Cloud · Acme',
      phase: 'repository',
      error: { step: 'repository', message: 'GitHub is not connected.', connectGithubUrl: 'https://app.solus.sh/connections' },
    })
    expect(card).toMatchObject({ status: 'error', recovery: 'connect-github', recoveryUrl: 'https://app.solus.sh/connections' })

    // Any other failure keeps the plain error: no action it cannot honour.
    const plain = buildRemoteDispatchCard({
      tabId: 'tab-1',
      hostLabel: 'Cloud · Acme',
      phase: 'repository',
      error: { step: 'repository', message: 'Disk full.' },
    })
    expect(plain.recovery).toBeUndefined()
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
        { id: 'worktree', label: 'Creating branch & worktree', status: 'active' },
        { id: 'workspace', label: 'Linking workspace', status: 'pending' },
        { id: 'session', label: 'Starting agent session', status: 'pending' },
      ],
    })

    expect(merged.id).toBe('remote-dispatch-tab-1')
    expect(merged.title).toBe('Starting on Studio')
    expect(merged.steps.map((step) => step.id)).toEqual([
      'connection',
      'repository',
      'worktree',
      'workspace',
      'session',
    ])
  })
})
