import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { answerAgentSettingsRequests } from '@solus/client-core/agent-settings-requests'
import {
  AGENT_PERSONAL_SETTINGS_REQUEST,
  DEFAULT_PERSONAL_SETTINGS,
  type AgentPersonalSettingsReply,
  type PersonalSettings,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import { actorFor, HOST_ACTOR, type Actor } from '@solus/server/admission/actor'
import type { Principal } from '@solus/server/admission/principal'
import {
  personalSettingsClients,
  requestPersonalSettings,
  type PersonalSettingsRoute,
} from '@solus/server/transport/events/agent-personal-settings'

function member(userId: string): Principal {
  return {
    kind: 'org-member', userId, organizationId: 'org-a', organizationRole: 'member', teamIds: [],
    hostKind: 'personal', displayName: userId, deviceId: `${userId}-device`, expiresAt: Date.now() + 60_000, deviceLabel: 'Laptop',
  }
}

const ALICE = member('alice')
const BOB = member('bob')

interface Fixture {
  principals: Record<string, Principal>
  actor: Actor | undefined
  sourceClientId?: string
  /** Clients whose socket is gone: a request to one rejects. */
  gone?: string[]
}

function routeOf(fixture: Fixture, asked: string[] = []): PersonalSettingsRoute {
  return {
    sourceClientIdOf: () => fixture.sourceClientId,
    actorOf: () => fixture.actor,
    clientIds: () => Object.keys(fixture.principals),
    principalOf: (clientId) => fixture.principals[clientId]!,
    request: async (clientId) => {
      asked.push(clientId)
      if (fixture.gone?.includes(clientId)) throw new Error(`No socket for ${clientId}`)
      return { ok: true, settings: { reviewModel: `answered-by-${clientId}` } }
    },
  }
}

describe("which client answers for a session's person", () => {
  test('the client that started the turn is asked first, then the same person\'s other clients', () => {
    const route = routeOf({
      principals: { 'alice-phone': ALICE, 'bob-laptop': BOB, 'alice-laptop': ALICE },
      actor: actorFor(ALICE),
      sourceClientId: 'alice-laptop',
    })

    expect(personalSettingsClients(route, 'session')).toEqual(['alice-laptop', 'alice-phone'])
  })

  test("an agent working for one person never reaches another person's settings", async () => {
    // Alice's agent must not read or change what Bob's clients show, even when
    // Bob is the only person connected.
    const asked: string[] = []
    const route = routeOf({ principals: { 'bob-laptop': BOB }, actor: actorFor(ALICE) }, asked)

    const reply = await requestPersonalSettings(route, 'session', { reviewModel: 'x' })

    expect(reply.ok).toBe(false)
    expect(asked).toEqual([])
  })

  test("the host's own work has no person, so no client is asked", () => {
    const route = routeOf({ principals: { 'alice-laptop': ALICE }, actor: HOST_ACTOR })
    expect(personalSettingsClients(route, 'session')).toEqual([])
  })

  test('a client whose socket is gone gives way to the next client of the same person', async () => {
    const asked: string[] = []
    const route = routeOf({
      principals: { 'alice-laptop': ALICE, 'alice-phone': ALICE },
      actor: actorFor(ALICE),
      sourceClientId: 'alice-laptop',
      gone: ['alice-laptop'],
    }, asked)

    const reply = await requestPersonalSettings(route, 'session')

    expect(asked).toEqual(['alice-laptop', 'alice-phone'])
    expect(reply).toEqual({ ok: true, settings: { reviewModel: 'answered-by-alice-phone' } })
  })
})

/** A transport that keeps the one request handler a client installs, as `WsTransport` does. */
class FakeTransport {
  private handler: ((wire: unknown) => Promise<unknown>) | null = null
  onServerRequest<Payload, Reply>(event: string, payload: z.ZodType<Payload>, handle: (payload: Payload) => Promise<Reply>, unreadable: Reply): () => void {
    expect(event).toBe(AGENT_PERSONAL_SETTINGS_REQUEST)
    this.handler = async (wire) => {
      const parsed = payload.safeParse(wire)
      return parsed.success ? handle(parsed.data) : unreadable
    }
    return () => { this.handler = null }
  }
  async send(wire: unknown): Promise<AgentPersonalSettingsReply> {
    // SAFETY: the handler answers with the reply type it was installed with.
    return (await this.handler!(wire)) as AgentPersonalSettingsReply
  }
}

function clientStore() {
  let values: PersonalSettings = structuredClone(DEFAULT_PERSONAL_SETTINGS)
  const localEdits: PersonalSettingsDocument[] = []
  return {
    localEdits,
    values: () => values,
    target: {
      current: () => values,
      apply: (patch: PersonalSettingsDocument) => {
        localEdits.push(patch)
        values = { ...values, ...patch }
        return true
      },
    },
  }
}

describe('a client answering for an agent', () => {
  test('a change is applied as a local edit, so sync sends it like one the person made', async () => {
    const transport = new FakeTransport()
    const store = clientStore()
    answerAgentSettingsRequests(transport, store.target)

    const reply = await transport.send({ patch: { reviewModel: 'gpt-6-luna', extraInstructions: 'Be brief.' } })

    expect(store.localEdits).toEqual([{ reviewModel: 'gpt-6-luna', extraInstructions: 'Be brief.' }])
    expect(reply.ok && reply.settings.extraInstructions).toBe('Be brief.')
  })

  test('a read changes nothing and returns every setting', async () => {
    const transport = new FakeTransport()
    const store = clientStore()
    answerAgentSettingsRequests(transport, store.target)

    const reply = await transport.send({})

    expect(store.localEdits).toEqual([])
    expect(reply.ok && reply.settings.reviewModel).toBe(DEFAULT_PERSONAL_SETTINGS.reviewModel)
  })

  test('a request the client cannot read is refused without touching the store', async () => {
    const transport = new FakeTransport()
    const store = clientStore()
    answerAgentSettingsRequests(transport, store.target)

    const reply = await transport.send({ patch: { notASetting: true } })

    expect(reply.ok).toBe(false)
    expect(store.localEdits).toEqual([])
  })
})
