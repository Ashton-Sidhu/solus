import { describe, expect, test } from 'bun:test'
import { resourceWatchWake, resourceWatchWakeHeader, type ResourceWatch } from '@solus/contracts/integrations/resource-watch'
import { resourceWatchItem, shownResourceWatches } from '@solus/client-core/resource-watch-row'
import { hostNoticeKind } from '../../packages/workspace-ui/src/components/conversation/lib/host-notice'

/**
 * A resource watch as the background work row that desktop, web, and mobile
 * share (docs/plans/mcp-first-class.md §11.5), and the notice its change starts
 * the agent with, known by its text after a reload.
 */

const base: ResourceWatch = {
  id: 'w1', sessionId: 's1', integrationName: 'Docs', uri: 'docs://notes', name: 'Release notes', state: 'watching',
  wakes: 0, createdAt: 1_000, updatedAt: 1_000, expiresAt: 86_401_000,
}

describe('resource watch row', () => {
  test('a live watch can be stopped at each state, and a watch that waits for news does not spin or tick', () => {
    for (const state of ['starting', 'watching', 'changed', 'needs-sign-in', 'unreachable'] as const) {
      expect(resourceWatchItem({ ...base, state }).actions.map((action) => action.id)).toEqual(['stop'])
    }
    expect(resourceWatchItem(base)).toMatchObject({ label: 'Docs · Release notes', detail: 'Watching for changes', state: 'waiting', startedAt: null })
    expect(resourceWatchItem({ ...base, wakes: 3 }).detail).toBe('Watching for changes · started the agent 3 times')
    expect(resourceWatchItem({ ...base, state: 'changed' })).toMatchObject({ state: 'running', detail: 'Changed · the agent starts soon' })
    expect(resourceWatchItem({ ...base, state: 'changed', message: 'The agent starts after the running turn.' }).detail).toBe('The agent starts after the running turn.')
    expect(resourceWatchItem({ ...base, state: 'needs-sign-in' })).toMatchObject({ state: 'attention', detail: 'Sign in to Docs again' })
    expect(resourceWatchItem({ ...base, state: 'unreachable' })).toMatchObject({ state: 'attention', detail: 'Could not reach Docs' })
  })

  test('an ended watch offers nothing and says why it ended', () => {
    const ended = (endReason: ResourceWatch['endReason'], extra: Partial<ResourceWatch> = {}) => resourceWatchItem({ ...base, state: 'ended', endReason, ...extra })
    expect(ended('stopped')).toMatchObject({ state: 'stopped', detail: 'Stopped', actions: [] })
    expect(ended('agent')).toMatchObject({ state: 'stopped', detail: 'Stopped by the agent' })
    expect(ended('limit', { wakes: 20 })).toMatchObject({ state: 'ended', detail: 'Ended: started the agent 20 times, its limit' })
    expect(ended('expired')).toMatchObject({ state: 'ended', detail: 'Ended after 24 hours' })
    expect(ended('session-archived')).toMatchObject({ state: 'stopped', detail: 'Ended: the session was archived' })
    expect(ended('host-restarted', { message: 'The host restarted and the server stopped.' })).toMatchObject({ state: 'failed', detail: 'The host restarted and the server stopped.' })
    expect(ended('server-stopped', { message: 'The server stopped.' })).toMatchObject({ state: 'failed', detail: 'The server stopped.' })
    expect(ended('refused', { message: 'The server does not send changes of this resource.' })).toMatchObject({ state: 'failed' })
  })

  test('the conversation shows live watches, and ended ones only during the turn they ended in', () => {
    const ended = { ...base, id: 'w2', state: 'ended' as const, endReason: 'stopped' as const, updatedAt: 500 }
    expect(shownResourceWatches([base, ended], 400).map((watch) => watch.id)).toEqual(['w1', 'w2'])
    expect(shownResourceWatches([base, ended], 600).map((watch) => watch.id)).toEqual(['w1'])
  })
})

describe('resource watch notice', () => {
  test('the host message reads back after a reload, with no origin', () => {
    const text = `${resourceWatchWakeHeader('Docs · Release notes')}\n\ndocs://notes of Docs changed.`
    expect(resourceWatchWake(text)).toEqual({ label: 'Docs · Release notes', body: 'docs://notes of Docs changed.' })
    expect(hostNoticeKind({ content: text })).toBe('resource-watch')
    expect(hostNoticeKind({ content: 'A watched MCP resource changed, said the person.' })).toBeNull()
    expect(hostNoticeKind({ content: 'anything', via: 'resource-watch' })).toBe('resource-watch')
  })
})
