import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { answerAgentPersonalRequests, summarizeAgentProfile } from '@solus/client-core/agent-personal-requests'
import { AGENT_PERSONAL_REQUEST, type AgentPersonalReply, type AgentProfileWrite } from '@solus/contracts/agent-personal-request'
import type { AgentProfile } from '@solus/contracts/agent-profile'
import { DEFAULT_PERSONAL_SETTINGS, type PersonalSettings, type PersonalSettingsDocument } from '@solus/contracts/settings'
import { actorFor, HOST_ACTOR, type Actor } from '@solus/server/admission/actor'
import type { Principal } from '@solus/server/admission/principal'
import { personalClients, requestPersonal, type PersonalRoute } from '@solus/server/transport/events/agent-personal-requests'

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

function routeOf(fixture: Fixture, asked: string[] = []): PersonalRoute {
  return {
    sourceClientIdOf: () => fixture.sourceClientId,
    actorOf: () => fixture.actor,
    clientIds: () => Object.keys(fixture.principals),
    principalOf: (clientId) => fixture.principals[clientId]!,
    request: async (clientId) => {
      asked.push(clientId)
      if (fixture.gone?.includes(clientId)) throw new Error(`No socket for ${clientId}`)
      return { ok: true, settings: { reviewModel: `answered-by-${clientId}` }, profile: [], device: null }
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

    expect(personalClients(route, 'session')).toEqual(['alice-laptop', 'alice-phone'])
  })

  test("an agent working for one person never reaches another person's settings", async () => {
    // Alice's agent must not read or change what Bob's clients show, even when
    // Bob is the only person connected.
    const asked: string[] = []
    const route = routeOf({ principals: { 'bob-laptop': BOB }, actor: actorFor(ALICE) }, asked)

    const reply = await requestPersonal(route, 'session', { settings: { reviewModel: 'x' } })

    expect(reply.reply.ok).toBe(false)
    expect(asked).toEqual([])
  })

  test("the host's own work has no person, so no client is asked", () => {
    const route = routeOf({ principals: { 'alice-laptop': ALICE }, actor: HOST_ACTOR })
    expect(personalClients(route, 'session')).toEqual([])
  })

  test('a client whose socket is gone gives way to the next client of the same person', async () => {
    const asked: string[] = []
    const route = routeOf({
      principals: { 'alice-laptop': ALICE, 'alice-phone': ALICE },
      actor: actorFor(ALICE),
      sourceClientId: 'alice-laptop',
      gone: ['alice-laptop'],
    }, asked)

    const reply = await requestPersonal(route, 'session', {})

    expect(asked).toEqual(['alice-laptop', 'alice-phone'])
    expect(reply).toEqual({ reply: { ok: true, settings: { reviewModel: 'answered-by-alice-phone' }, profile: [], device: null }, fromTurnClient: false })
  })

  test("a device change goes only to the turn's client, never to another machine of the person", async () => {
    const asked: string[] = []
    const route = routeOf({
      principals: { 'alice-laptop': ALICE, 'alice-phone': ALICE },
      actor: actorFor(ALICE),
      sourceClientId: 'alice-laptop',
      gone: ['alice-laptop'],
    }, asked)

    const answer = await requestPersonal(route, 'session', { device: { zoomFactor: 1.5 } })

    expect(asked).toEqual(['alice-laptop'])
    expect(answer.reply.ok).toBe(false)
  })
})

/** A transport that keeps the one request handler a client installs, as `WsTransport` does. */
class FakeTransport {
  private handler: ((wire: unknown) => Promise<unknown>) | null = null
  onServerRequest<Payload, Reply>(event: string, payload: z.ZodType<Payload>, handle: (payload: Payload) => Promise<Reply>, unreadable: Reply): () => void {
    expect(event).toBe(AGENT_PERSONAL_REQUEST)
    this.handler = async (wire) => {
      const parsed = payload.safeParse(wire)
      return parsed.success ? handle(parsed.data) : unreadable
    }
    return () => { this.handler = null }
  }
  async send(wire: unknown): Promise<AgentPersonalReply> {
    // SAFETY: the handler answers with the reply type it was installed with.
    return (await this.handler!(wire)) as AgentPersonalReply
  }
}

function clientStore() {
  let values: PersonalSettings = structuredClone(DEFAULT_PERSONAL_SETTINGS)
  let profile: AgentProfile = {}
  const localEdits: Array<PersonalSettingsDocument | AgentProfileWrite> = []
  return {
    localEdits,
    profile: () => profile,
    target: {
      settings: () => values,
      applySettings: (patch: PersonalSettingsDocument) => {
        localEdits.push(patch)
        values = { ...values, ...patch }
        return true
      },
      profile: () => profile,
      applyProfile: (change: AgentProfileWrite) => {
        localEdits.push(change)
        profile = { ...profile, ...change.set }
        for (const key of change.reset) delete profile[key]
        return true
      },
    },
  }
}

const SKILL = { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' } as const

describe('a client answering for an agent', () => {
  test('a change is applied as a local edit, so sync sends it like one the person made', async () => {
    const transport = new FakeTransport()
    const store = clientStore()
    answerAgentPersonalRequests(transport, store.target)

    const reply = await transport.send({ settings: { reviewModel: 'gpt-6-luna', extraInstructions: 'Be brief.' }, profile: { set: { 'skill:deploy': SKILL } } })

    expect(store.localEdits).toEqual([{ reviewModel: 'gpt-6-luna', extraInstructions: 'Be brief.' }, { set: { 'skill:deploy': SKILL }, reset: [] }])
    expect(reply.ok && reply.settings.extraInstructions).toBe('Be brief.')
    expect(reply.ok && reply.profile).toEqual([SKILL])
  })

  test('a read changes nothing and returns every setting', async () => {
    const transport = new FakeTransport()
    const store = clientStore()
    answerAgentPersonalRequests(transport, store.target)

    const reply = await transport.send({})

    expect(store.localEdits).toEqual([])
    expect(reply.ok && reply.settings.reviewModel).toBe(DEFAULT_PERSONAL_SETTINGS.reviewModel)
  })

  test('a client that keeps no device settings refuses a device change and reads as none', async () => {
    // The phone app has no device settings an agent may change.
    const transport = new FakeTransport()
    const store = clientStore()
    answerAgentPersonalRequests(transport, store.target)

    expect((await transport.send({ device: { zoomFactor: 1.5 } })).ok).toBe(false)
    const read = await transport.send({})
    expect(read.ok && read.device).toBeNull()
  })

  test('a request the client cannot read is refused without touching the store', async () => {
    const transport = new FakeTransport()
    const store = clientStore()
    answerAgentPersonalRequests(transport, store.target)

    const reply = await transport.send({ settings: { notASetting: true } })

    expect(reply.ok).toBe(false)
    expect(store.localEdits).toEqual([])
  })
})

describe('the profile an agent reads', () => {
  test('a file is its path, size, and hash, without its content', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'héllo']) {
      const contentBase64 = Buffer.from(text).toString('base64')
      const [file] = summarizeAgentProfile({ 'file:codex/prompts/p.md': { kind: 'file', provider: 'codex', path: 'prompts/p.md', contentBase64, hash: 'f'.repeat(64) } })
      expect(file).toEqual({ kind: 'file', provider: 'codex', path: 'prompts/p.md', hash: 'f'.repeat(64), bytes: Buffer.byteLength(text) })
    }
  })
})
