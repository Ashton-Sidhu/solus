import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostEvent } from '@solus/contracts/host-events'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/running-turn-open.md: a client that opens a running session holds
// the events that come before the watch's answer and applies them as the turn
// so far, in one step. The replay goes through the client's event queue, behind
// an audience check that reads the share list. If the answer passes the replay,
// the client applies the whole turn as live events: on the phone it streams the
// turn from its prompt instead of joining it where it is.

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-watch-replay-order-'))
  process.env.SOLUS_DATA_DIR = dataDir
})

afterAll(async () => {
  ;(await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

type Handler = (args: unknown[], ctx: { clientId: string; principal: unknown }) => Promise<unknown>

describe('watchSession', () => {
  test('answers after its replay reached the client', async () => {
    const { registerSessionHandlers } = await import('@solus/server/transport/handlers/session-handlers')
    const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
    const { HostEventPublisher } = await import('@solus/server/transport/events/host-event-publisher')
    const { withActor } = await import('./helpers/actors')

    // A share read that takes longer than the rest of the watch.
    const registry = new ClientEventRegistry(() => new Promise<boolean>(resolve => setTimeout(() => resolve(true), 20)))
    const publisher = new HostEventPublisher(registry)
    const received: HostEvent[] = []
    registry.register('ws:phone', event => received.push(event))

    const sessionRuntime = {
      isKnownSession: () => true,
      watchers: {
        watchSession: (input: { sessionId: string }, clientId: string) => {
          for (const text of ['the prompt', 'a reply']) {
            void publisher.publishToRoom({ kind: 'session', id: input.sessionId }, [clientId], 'session.eventReceived', {
              sessionId: input.sessionId, event: { type: 'assistant_message', text },
            })
          }
          return { runtime: null, runningTurnStartedAt: 1 }
        },
      },
    }
    const handlers = new Map<string, Handler>()
    const server = { register: (name: string, handler: Handler) => handlers.set(name, (args, ctx) => handler(args, withActor(ctx as never))) } as never
    registerSessionHandlers(server, {
      sessionRuntime, clientEvents: registry, orchestrator: { mayAnswer: () => true }, agentIdFromContext: () => 'claude-code',
    } as never)

    await handlers.get('watchSession')!([{ sessionId: 's1', attachRuntime: true }], { clientId: 'ws:phone', principal: { kind: 'owner' } })

    expect(received.map(event => event.type === 'session.eventReceived' && event.payload.event.type === 'assistant_message' ? event.payload.event.text : null))
      .toEqual(['the prompt', 'a reply'])
  })
})
