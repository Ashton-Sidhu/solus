import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CodexAppServerClient } from '@solus/server/agents/codex/codex-agent'
import type { NormalizedEvent } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/agents/codex/codex-backend')['CodexBackend']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/agents/codex/codex-backend'))
})

// WHY: each member's seat runs its own Codex app-server, and every app-server
// numbers its requests from the start. A question id made from the request id
// alone let two sessions on different seats share one id, so one member's
// answer could approve the other member's command. The id names the app-server
// too, and an answer goes back on the app-server that asked.

type Responses = Array<[string, string | number]>

function recordingClient(name: string, responses: Responses, home?: string): CodexAppServerClient {
  const client = new CodexAppServerClient(home ? { codexHome: home } : {})
  client.respond = (id) => { responses.push([name, id]) }
  return client
}

function backendWithTwoSeats() {
  const backend = new CodexBackend()
  const responses: Responses = []
  const host = recordingClient('host', responses)
  const bob = recordingClient('bob', responses, '/seats/codex/bob')
  const attach = Reflect.get(backend, 'attachClient') as (client: CodexAppServerClient) => void
  Reflect.apply(attach, backend, [host])
  Reflect.apply(attach, backend, [bob])
  const activeRuns = Reflect.get(backend, 'activeRuns') as Map<string, { client: CodexAppServerClient; permissionMode: string; sawPermissionRequest: boolean }>
  activeRuns.set('thread-a', { client: host, permissionMode: 'ask', sawPermissionRequest: false })
  activeRuns.set('thread-b', { client: bob, permissionMode: 'ask', sawPermissionRequest: false })
  const asked: Array<{ threadId: string; questionId: string }> = []
  const resolved: string[] = []
  backend.on('normalized', (threadId: string, event: NormalizedEvent) => {
    if (event.type === 'permission_request') asked.push({ threadId, questionId: event.questionId })
    if (event.type === 'permission_resolved') resolved.push(event.questionId)
  })
  const ask = (client: CodexAppServerClient, threadId: string) => client.emit('server-request', {
    jsonrpc: '2.0', id: 7, method: 'item/commandExecution/requestApproval', params: { threadId, command: 'rm -rf build' },
  })
  return { backend, responses, host, bob, asked, resolved, ask }
}

describe('Codex question ids across seats', () => {
  test('the same request id from two app-servers is two questions, each answered on its own app-server', () => {
    const { backend, responses, host, bob, asked, ask } = backendWithTwoSeats()
    ask(host, 'thread-a')
    ask(bob, 'thread-b')
    expect(asked).toHaveLength(2)
    const [forA, forB] = asked
    expect(forA!.questionId).not.toBe(forB!.questionId)

    expect(backend.permissions.respondToPermission(forB!.questionId, 'accept')).toBe(true)
    expect(responses).toEqual([['bob', 7]])
    // Thread A's request is still waiting, untouched by B's answer.
    expect(backend.permissions.getPendingInfo(forA!.questionId)).toMatchObject({ sessionId: 'thread-a' })
    expect(backend.permissions.respondToPermission(forA!.questionId, 'decline')).toBe(true)
    expect(responses).toEqual([['bob', 7], ['host', 7]])
  })

  test("an app-server settling its own request clears only that app-server's question", () => {
    const { backend, host, bob, asked, resolved, ask } = backendWithTwoSeats()
    ask(host, 'thread-a')
    ask(bob, 'thread-b')
    const [forA, forB] = asked
    host.emit('notification', { jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: 7 } })
    expect(resolved).toEqual([forA!.questionId])
    expect(backend.permissions.getPendingInfo(forA!.questionId)).toBeUndefined()
    expect(backend.permissions.getPendingInfo(forB!.questionId)).toMatchObject({ sessionId: 'thread-b' })
  })
})
