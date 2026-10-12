import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import { asHostApi } from '@solus/client-core/host-api'
import type { DocumentSyncClock } from '@solus/client-core/document-sync'
import {
  agentProfileEntrySchema,
  agentProfileKeyOf,
  type AccountAgentProfileResponse,
  type AgentProfile,
  type AgentProfileStatus,
} from '@solus/contracts/agent-profile'
import { SolusApp } from '../../apps/mobile/src/app/solus-app'
import { AgentProfileLocalStore } from '../../apps/mobile/src/features/settings/agent-profile-local'
import { DeviceAgentProfileSync, type ReachableHost } from '../../apps/mobile/src/features/settings/agent-profile-sync'
import {
  agentProfileParts,
  decodeBase64,
  encodeBase64,
  entryKeyLabel,
  entryValueText,
  fileEntryFromText,
  fileEntryText,
  hostProfileText,
  integrationEntryFromProbe,
  sha256Hex,
  skillEntryFromRemote,
} from '../../apps/mobile/src/features/settings/lib/agent-profile-entries'
import { AGENT_PROFILE_SUBJECT, SETTINGS_SUBJECT, syncStatusDetail } from '../../apps/mobile/src/features/settings/lib/sync-text'
import { alwaysOnlineEnvironment } from '../../apps/mobile/src/features/settings/personal-sync'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import { FakeApi, FakeTransport, flushPromises, seedAccountGrant } from './helpers/native-mobile-fakes'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// plans/020-agent-profile.md §3 on the phone. The rules pinned here are the ones
// a person would notice going wrong: an instruction typed here becomes the same
// file entry a host would make, with the key and hash every other client
// compares; the cloud cannot push, so after this device's write is confirmed,
// and when sync turns on, every connected host is asked to pull, and no host
// after sync is turned off.

const ACCOUNT = { origin: 'https://app.solus.sh', userId: 'user-1' }

const PULLED: AgentProfileStatus = { syncedAt: 5, source: 'account', revision: 1, counts: { files: 1, skills: 0, integrations: 0 }, skipped: [] }

/** One account's synced profile in memory, with every request recorded. */
function fakeCloud(initial: AgentProfile | null = null) {
  let document: AccountAgentProfileResponse = { schemaVersion: 1, generation: 0, revision: initial ? 1 : null, entries: initial ?? {}, updatedAt: initial ? 1 : null }
  const calls: string[] = []
  const requests: AgentProfileCloudRequests = {
    accountAgentProfileGet: async () => { calls.push('get'); return { kind: 'ok', profile: structuredClone(document) } },
    accountAgentProfilePatch: async (request) => {
      calls.push(`patch:${Object.keys(request.set).join(',')}${request.reset?.length ? `;reset:${request.reset.join(',')}` : ''}`)
      if (request.expectedRevision !== document.revision) return { kind: 'conflict', reason: 'profile_conflict', current: structuredClone(document) }
      const entries = { ...document.entries, ...request.set }
      for (const key of request.reset ?? []) delete entries[key]
      document = { ...document, revision: (document.revision ?? 0) + 1, entries, updatedAt: 2 }
      return { kind: 'ok', profile: structuredClone(document) }
    },
    accountAgentProfileDelete: async () => { calls.push('delete'); return { kind: 'ok', profile: document } },
  }
  return { requests, calls, document: () => document }
}

/** Timers that run only when the test says so. */
function manualClock(): DocumentSyncClock & { runAll(): void } {
  const timers = new Set<() => void>()
  return {
    now: () => 1_000,
    setTimer: (callback) => {
      timers.add(callback)
      return () => { timers.delete(callback) }
    },
    runAll: () => {
      const due = [...timers]
      timers.clear()
      for (const callback of due) callback()
    },
  }
}

function pullingHost(hostId: string): ReachableHost & { api: ReturnType<typeof asHostApi>; fake: FakeApi } {
  const fake = new FakeApi().on('agentProfilePull', () => PULLED).on('agentProfileStatus', () => PULLED)
  return { hostId, api: asHostApi(fake.surface()), fake }
}

const nodeSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('an instruction edit becomes a file entry', () => {
  test('hashed and encoded as a host does it, for every block boundary', () => {
    for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'Be brief.\n', 'Ünïcödé — 日本語 🚀'.repeat(40)]) {
      const bytes = new TextEncoder().encode(text)
      expect(sha256Hex(bytes)).toBe(nodeSha256(bytes))
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
      expect(new TextDecoder().decode(decodeBase64(encodeBase64(bytes)))).toBe(text)
    }
  })

  test('with the key every client compares, and it round-trips to the text typed', () => {
    const entry = fileEntryFromText('claude-code', 'CLAUDE.md', 'Be brief.\n')
    expect(agentProfileKeyOf(entry)).toBe('file:claude-code/CLAUDE.md')
    expect(entry.hash).toBe(nodeSha256(new TextEncoder().encode('Be brief.\n')))
    expect(agentProfileEntrySchema.safeParse(entry).success).toBe(true)
    expect(fileEntryText(entry)).toBe('Be brief.\n')
  })

  test('the local copy keeps it per account, reports it as a local change, and never reports a cloud change back', () => {
    const storage = memoryKeyValueStore()
    const local = new AgentProfileLocalStore(storage)
    local.setAccount(ACCOUNT)
    const reported: unknown[] = []
    local.onLocalChange((change) => reported.push(change))
    const entry = fileEntryFromText('codex', 'AGENTS.md', 'Run the tests.')
    expect(local.setEntry(entry)).toBe('saved')
    expect(reported).toEqual([{ set: { 'file:codex/AGENTS.md': entry }, reset: [] }])
    expect(JSON.parse(storage.getItem('solus.agent-profile.v1:https://app.solus.sh|user-1')!)).toEqual({ entries: { 'file:codex/AGENTS.md': entry } })

    const skill = skillEntryFromRemote({ id: 'acme/skills@review', name: 'review', repo: 'acme/skills', url: 'https://skills.sh/acme/skills/review' })
    local.applyRemote({ set: { 'skill:review': skill }, reset: ['file:codex/AGENTS.md'] })
    expect(local.entries()).toEqual({ 'skill:review': skill })
    expect(reported).toHaveLength(1)

    // An entry the contract does not know is refused; the host decides the rest when it applies.
    expect(local.setEntry({ kind: 'skill', name: 'bad name!', source: 'acme/skills', skillId: 'x' })).toBe('invalid')
    expect(new AgentProfileLocalStore(storage).entries()).toEqual({})
    const reloaded = new AgentProfileLocalStore(storage)
    reloaded.setAccount(ACCOUNT)
    expect(reloaded.entries()).toEqual({ 'skill:review': skill })
  })
})

describe('the nudge: hosts pull after this device writes', () => {
  function device(cloud = fakeCloud()) {
    const clock = manualClock()
    const local = new AgentProfileLocalStore(memoryKeyValueStore())
    const hosts = [pullingHost('inst-a'), pullingHost('inst-b')]
    const sync = new DeviceAgentProfileSync(local, { requests: cloud.requests, storage: memoryKeyValueStore(), environment: alwaysOnlineEnvironment, clock }, () => hosts)
    sync.followAccount(ACCOUNT)
    const pulls = () => hosts.map((host) => host.fake.callsOf('agentProfilePull').length)
    return { cloud, clock, local, hosts, sync, pulls }
  }

  test('enabling with this device as the seed sends the copy, then every connected host pulls once', async () => {
    const { cloud, local, sync, pulls } = device()
    local.setEntry(fileEntryFromText('claude-code', 'CLAUDE.md', 'Before sync.'))
    expect(cloud.calls).toEqual([])
    expect(await sync.prepareEnable()).toEqual({ kind: 'offer', offer: { kind: 'absent', generation: 0 } })
    expect(await sync.enable('seed')).toEqual({ kind: 'enabled' })
    await flushPromises()
    expect(Object.keys(cloud.document().entries)).toEqual(['file:claude-code/CLAUDE.md'])
    expect(pulls()).toEqual([1, 1])
    expect(sync.hostState('inst-a')).toEqual({ status: PULLED, error: null, busy: false })
  })

  test('a confirmed write pulls each host; a change while turned off pulls none', async () => {
    const { cloud, clock, local, sync, pulls } = device()
    await sync.prepareEnable()
    await sync.enable('seed')
    await flushPromises()
    expect(pulls()).toEqual([1, 1])

    local.setEntry(fileEntryFromText('claude-code', 'CLAUDE.md', 'Be brief.'))
    expect(sync.current().state).toBe('pending')
    expect(pulls()).toEqual([1, 1])
    clock.runAll()
    await sync.engine.idle()
    await flushPromises()
    expect(cloud.calls.at(-1)).toBe('patch:file:claude-code/CLAUDE.md')
    expect(sync.current().state).toBe('synced')
    expect(pulls()).toEqual([2, 2])

    sync.turnOff()
    local.setEntry(fileEntryFromText('codex', 'AGENTS.md', 'Local only.'))
    clock.runAll()
    await sync.engine.idle()
    await flushPromises()
    expect(sync.current().state).toBe('off')
    expect(Object.keys(cloud.document().entries)).toEqual(['file:claude-code/CLAUDE.md'])
    expect(pulls()).toEqual([2, 2])
  })

  test('a host that refuses keeps its error, and Remove sends the empty profile', async () => {
    const { sync, hosts } = device()
    hosts[0]!.fake.on('agentProfilePull', () => { throw new Error('You have no seat on this host.') })
    hosts[1]!.fake.on('agentProfileApply', () => ({ ...PULLED, syncedAt: null, source: null, counts: { files: 0, skills: 0, integrations: 0 } }))
    await sync.pull('inst-a')
    expect(sync.hostState('inst-a')).toEqual({ status: null, error: 'You have no seat on this host.', busy: false })
    await sync.remove('inst-b')
    expect(hosts[1]!.fake.callsOf('agentProfileApply')).toEqual([[{ profile: {}, skipped: [] }]])
    expect(sync.hostState('inst-b').status?.syncedAt).toBeNull()
    await sync.pull('inst-c')
    expect(sync.hostState('inst-c').error).toBe('This host is not connected.')
  })

  test('through the app, only a host that is connected is asked', async () => {
    const cloud = fakeCloud()
    const secrets = memorySecretStore()
    const plane = fakeAccountPlane({ clientId: 'solus-mobile' })
    await seedAccountGrant(secrets, { userId: ACCOUNT.userId, refreshToken: plane.deviceTokens().refresh_token })
    const apis = new Map<string, FakeApi>()
    const transports: FakeTransport[] = []
    const app = new SolusApp({
      storage: memoryKeyValueStore(),
      secrets,
      cloudOrigin: ISSUER,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith(ISSUER) && !url.includes('/v1/')) return plane.fetch(url, init)
        const health = /^(http:\/\/[ab]:1)\/health$/.exec(url)
        if (health) return new Response(JSON.stringify({ ok: true, installationId: `inst-${health[1]!.slice(7, 8)}`, name: 'Mac', os: 'macos' }), { status: 200 })
        if (url.endsWith('/v1/account/agent-profile')) {
          const result = init?.method === 'PATCH'
            ? await cloud.requests.accountAgentProfilePatch(JSON.parse(String(init.body)))
            : await cloud.requests.accountAgentProfileGet()
          return new Response(JSON.stringify(result.kind === 'ok' ? result.profile : {}), { status: result.kind === 'ok' ? 200 : 500 })
        }
        return new Response('{}', { status: 404 })
      }) as typeof fetch,
      createTransport: (options) => {
        const api = new FakeApi().on('agentProfilePull', () => PULLED)
        apis.set(options.serverId, api)
        const transport = new FakeTransport(options, api)
        transports.push(transport)
        return transport
      },
      openBrowser: async () => {},
      deviceLabel: 'Solus for iPhone',
      uuid: () => 'u',
    })
    await app.load()
    await app.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    await app.registry.savePaired({ id: 'inst-b', label: 'B', url: 'http://b:1' }, 'tb')
    app.connections.connection('inst-a')
    app.connections.connection('inst-b')
    await transports[0]!.accept()
    expect(app.connections.state('inst-a')?.phase).toBe('connected')
    expect(app.connections.state('inst-b')?.phase).not.toBe('connected')

    expect(app.agentProfileSync.current().state).toBe('off')
    await app.agentProfileSync.prepareEnable()
    expect(await app.agentProfileSync.enable('seed')).toEqual({ kind: 'enabled' })
    await flushPromises()
    expect(apis.get('inst-a')!.callsOf('agentProfilePull')).toHaveLength(1)
    expect(apis.get('inst-b')!.callsOf('agentProfilePull')).toHaveLength(0)
    expect(cloud.document().revision).toBe(1)
  })
})

describe('the parts the screen shows', () => {
  test('files under skills/ group into one hand-written skill; a probe and a registry result become one entry each', () => {
    const parts = agentProfileParts({
      'file:claude-code/CLAUDE.md': fileEntryFromText('claude-code', 'CLAUDE.md', 'Hi'),
      'file:claude-code/agents/reviewer.md': fileEntryFromText('claude-code', 'agents/reviewer.md', 'Review'),
      'file:claude-code/skills/deploy/SKILL.md': fileEntryFromText('claude-code', 'skills/deploy/SKILL.md', '# Deploy'),
      'file:claude-code/skills/deploy/scripts/run.sh': fileEntryFromText('claude-code', 'skills/deploy/scripts/run.sh', 'echo'),
      'file:codex/AGENTS.md': fileEntryFromText('codex', 'AGENTS.md', 'Hi'),
      'skill:review': skillEntryFromRemote({ id: 'acme/skills@review', name: 'review', repo: 'acme/skills', url: 'https://skills.sh/acme/skills/review' }),
      'integration:linear': { kind: 'integration', slug: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: { kind: 'oauth', discover: 'https://mcp.linear.app/.well-known/oauth-protected-resource', registration: 'dynamic' } },
    })
    expect(parts.files.map((entry) => entry.path)).toEqual(['CLAUDE.md', 'agents/reviewer.md', 'AGENTS.md'])
    expect(parts.handWrittenSkills).toEqual([{ name: 'deploy', provider: 'claude-code', keys: ['file:claude-code/skills/deploy/SKILL.md', 'file:claude-code/skills/deploy/scripts/run.sh'] }])
    expect(parts.registrySkills.map((skill) => `${skill.source}@${skill.skillId}`)).toEqual(['acme/skills@review'])
    expect(parts.integrations.map((integration) => integration.slug)).toEqual(['linear'])

    const signals: never[] = []
    expect(integrationEntryFromProbe('https://mcp.example.com/mcp ', { outcome: 'credentials-required', auth: { kind: 'bearer', scheme: 'bearer' }, signals }))
      .toEqual({ kind: 'integration', slug: 'mcp-example-com', name: 'mcp.example.com', url: 'https://mcp.example.com/mcp', auth: { kind: 'bearer', scheme: 'bearer' } })
    expect(integrationEntryFromProbe('https://x.example', { outcome: 'undetermined', reason: 'not_mcp', signals })).toBeNull()
  })

  test('a conflict row names the entry and each side; a host line says where its copy came from', () => {
    const mine = { 'file:claude-code/CLAUDE.md': fileEntryFromText('claude-code', 'CLAUDE.md', 'Be  brief.\n') }
    expect(entryKeyLabel('file:claude-code/CLAUDE.md')).toBe('CLAUDE.md (Claude Code)')
    expect(entryKeyLabel('skill:review')).toBe('Skill review')
    expect(entryValueText(mine, 'file:claude-code/CLAUDE.md')).toBe('Be brief.')
    expect(entryValueText({}, 'file:claude-code/CLAUDE.md')).toBe('Removed')
    expect(hostProfileText(PULLED, null, (ms) => `at ${ms}`)).toBe('Copied from your account at 5: 1 file.')
    expect(hostProfileText({ ...PULLED, syncedAt: null }, null, String)).toBe('Not on this host yet.')
    expect(hostProfileText(null, 'Refused.', String)).toBe('Refused.')
    const off = { state: 'off' as const, lastSyncedAt: null, pendingKeys: [], error: null, stoppedReason: null }
    expect(syncStatusDetail(off, String, AGENT_PROFILE_SUBJECT)).toBe('Your agent profile stays on this device. Turn sync on to share it with your other devices.')
    expect(syncStatusDetail(off, String, SETTINGS_SUBJECT)).toBe('Your settings stay on this device. Turn sync on to share them with your other devices.')
  })
})

describe('navigation', () => {
  test('the agent profile screen opens without a host, from Settings and from the account page', () => {
    const mobile = resolve(import.meta.dir, '../../apps/mobile/src')
    expect(readFileSync(join(mobile, 'navigation/routes.ts'), 'utf8')).toMatch(/\n\s*AgentProfile: undefined\n/)
    expect(readFileSync(join(mobile, 'navigation/RootNavigator.tsx'), 'utf8')).toContain('name="AgentProfile"')
    for (const screen of ['features/settings/SettingsScreen.tsx', 'features/account/CloudHostsScreen.tsx']) {
      expect(readFileSync(join(mobile, screen), 'utf8')).toContain('navigate("AgentProfile")')
    }
  })
})
