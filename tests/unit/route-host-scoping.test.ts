import { describe, expect, test } from 'bun:test'
import {
  parseRef,
  serializeRef,
  type RouteRef,
} from '../../src/renderer/contexts/workspace/routing/route-registry'

function roundTrip(ref: RouteRef): RouteRef | null {
  return parseRef(serializeRef(ref))
}

describe('host-scoped route grammar', () => {
  // WHY: dispatch-client step 1 — one grammar for every host-scoped id:
  // `<id>~<serverId>` inside the id's own segment. The prReview/automation
  // `host~<id>` path segment is gone.
  test('every session-shaped route round-trips its host', () => {
    const refs: RouteRef[] = [
      { name: 'chat', params: { sessionId: 'sess-1', serverId: 'host-a' } },
      { name: 'goal', params: { sessionId: 'sess-1', serverId: 'host-a' } },
      { name: 'subagent', params: { sessionId: 'sess-1', messageId: 'msg-9', serverId: 'host-a' } },
      { name: 'task', params: { taskId: 'task-1', serverId: 'host-a' } },
      { name: 'plan', params: { planId: 'sess__tool', serverId: 'host-a' } },
      { name: 'automation', params: { automationId: 'auto-1', serverId: 'host-a' } },
      { name: 'prReview', params: { number: 12, serverId: 'host-a', cwd: '/repo/app' } },
      { name: 'prDiff', params: { number: 12, serverId: 'host-a', cwd: '/repo/app' } },
    ]
    for (const ref of refs) {
      expect(roundTrip(ref)).toEqual(ref)
    }
  })

  test('a route without a host stays host-less, never host-guessed', () => {
    const refs: RouteRef[] = [
      { name: 'goal', params: { sessionId: 'sess-1' } },
      { name: 'task', params: { taskId: 'task-1' } },
      { name: 'subagent', params: { sessionId: 'sess-1', messageId: 'msg-9' } },
      { name: 'prDiff', params: { number: 12 } },
    ]
    for (const ref of refs) {
      expect(roundTrip(ref)).toEqual(ref)
    }
  })

  test('a streamed plan with no id still serializes its host', () => {
    const ref: RouteRef = { name: 'plan', params: { planId: null, serverId: 'host-a' } }
    expect(roundTrip(ref)).toEqual(ref)
  })
})
