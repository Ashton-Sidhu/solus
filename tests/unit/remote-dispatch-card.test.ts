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
