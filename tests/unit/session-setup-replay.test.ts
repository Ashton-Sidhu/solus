import { afterAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { NormalizedEvent } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { SessionRuntime } = await import('@solus/server/execution/session-runtime')
const { closeDb } = await import('@solus/server/db')
const { closeDatabase } = await import('@solus/server/db/database')
afterAll(async () => { await closeDatabase(); closeDb() })

test('a client joining before the provider starts receives the latest setup stage and output', () => {
  const runtime = new SessionRuntime(new Map())
  const first: NormalizedEvent = { type: 'status_card', card: { id: 'setup', title: 'Preparing', status: 'active', steps: [] } }
  const latest: NormalizedEvent = { type: 'status_card', card: { id: 'setup', title: 'Linking workspace', status: 'active', steps: [{ id: 'create', label: 'Create worktree', status: 'done' }], output: ['Created branch'] } }
  runtime.turnLog.set('s', [first, latest])
  runtime.launcher.pendingSetupControllers.set('s', new AbortController())
  const received: NormalizedEvent[] = []
  runtime.on('event', (_sessionId, event) => received.push(event))
  try {
    const watch = runtime.watchers.watchSession({ sessionId: 's', attachRuntime: true }, 'joining-client')
    expect(received).toEqual([latest, { type: 'status_change', status: 'connecting', oldStatus: 'connecting' }])
    expect(watch.runtime?.status).toBe('connecting')
    expect(runtime.turnLog.get('s')).toEqual([first, latest])
  } finally { runtime.shutdown() }
})


test('a stopped bootstrap cannot replay a stage as still running', () => {
  const runtime = new SessionRuntime(new Map())
  runtime.turnLog.set('stopped', [
    { type: 'status_card', card: { id: 'setup', icon: 'git-branch', title: 'Preparing', status: 'active', steps: [{ id: 'create', label: 'Create worktree', status: 'active' }], output: ['Creating branch'] } },
    { type: 'status_change', status: 'interrupted', oldStatus: 'connecting' },
  ])
  const received: NormalizedEvent[] = []
  runtime.on('event', (_sessionId, event) => received.push(event))
  try {
    runtime.watchers.watchSession({ sessionId: 'stopped', attachRuntime: true }, 'joining-client')
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'status_card', card: { status: 'error', title: 'Worktree setup stopped', output: ['Creating branch'], steps: [{ status: 'error' }] } })
  } finally { runtime.shutdown() }
})

test('only the host worktree setup takes the worktree setup card', async () => {
  // WHY: client-side git cards (PR checkout, conflict resolution) have their own
  // titles and no setup to cancel; they must keep the ordinary status card.
  const { isWorktreeSetupCard, worktreeSetupCardId } = await import('@solus/contracts/setup-card')
  const { buildConflictResolverCard } = await import('@solus/workspace-ui/lib/pr-conflict-resolution')
  const hostCard = { id: worktreeSetupCardId('s'), title: 'Preparing worktree…', icon: 'git-branch' as const, status: 'active' as const, steps: [] }
  expect(isWorktreeSetupCard(hostCard)).toBe(true)
  expect(isWorktreeSetupCard(buildConflictResolverCard(7, 'worktree'))).toBe(false)
})

test('a finished turn settles setup as ready, and output keeps a fixed window', async () => {
  const { settleSetupCard, setupOutputWindow } = await import('@solus/contracts/setup-card')
  const card = { id: 'worktree-s', title: 'Preparing', icon: 'git-branch' as const, status: 'active' as const, steps: [{ id: 'session', label: 'Starting agent session', status: 'active' as const }] }
  expect(settleSetupCard(card, 'completed')).toMatchObject({ status: 'done', title: 'Worktree ready', steps: [{ status: 'done' }] })
  expect(settleSetupCard(card, 'failed')).toMatchObject({ status: 'error', steps: [{ status: 'error' }] })
  expect(setupOutputWindow(['a', '', 'b'])).toEqual([' ', 'a', ' ', 'b'])
  expect(setupOutputWindow(['1', '2', '3', '4', '5'])).toEqual(['2', '3', '4', '5'])
})
