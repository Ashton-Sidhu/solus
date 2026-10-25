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
import { AccountSync, alwaysOnlineEnvironment, type ReachableHost } from '../../apps/mobile/src/features/account/account-sync'
import { PersonalSettingsStore } from '../../apps/mobile/src/features/settings/personal-settings'
import type { SettingsCloudRequests } from '@solus/client-core/settings-requests'
import {
  agentProfileParts,
  entryKeyLabel,
  entryValueText,
  hostProfileText,
  integrationEntryFromProbe,
  profileServerStatus,
  skillEntryFromRemote,
} from '../../apps/mobile/src/features/settings/lib/agent-profile-entries'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import { FakeApi, FakeTransport, flushPromises, seedAccountGrant } from './helpers/native-mobile-fakes'
import { identityKeyFor, signedHealth } from './helpers/signing-host'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// plans/020-agent-profile.md §3 on the phone. The rules pinned here are the ones
// a person would notice going wrong: signed in means synced, so signing in starts sync without a
// choice; the cloud cannot push, so after this device's write is confirmed, and
// when sync starts, every connected host is asked to pull; a hand-written
// skill is removed as one change of all its files.

const ACCOUNT = { origin: 'https://app.solus.sh', userId: 'user-1' }

const PULLED: AgentProfileStatus = { syncedAt: 5, source: 'account', revision: 1, counts: { files: 1, skills: 0, integrations: 0 }, skipped: [] }

/** One account's synced profile in memory, with every request recorded. */
function fakeCloud(initial: AgentProfile | null = null) {
  let failGets = 0
  let document: AccountAgentProfileResponse = { schemaVersion: 1, generation: 0, revision: initial ? 1 : null, entries: initial ?? {}, updatedAt: initial ? 1 : null }
  const calls: string[] = []
  const requests: AgentProfileCloudRequests = {
    accountAgentProfileGet: async () => {
      calls.push('get')
      if (failGets > 0) {
        failGets -= 1
        return { kind: 'offline' }
      }
      return { kind: 'ok', profile: structuredClone(document) }
    },
    accountAgentProfilePatch: async (request) => {
      calls.push(`patch:${Object.keys(request.set).join(',')}${request.reset?.length ? `;reset:${request.reset.join(',')}` : ''}`)
      if (request.expectedRevision !== document.revision) return { kind: 'conflict', reason: 'profile_conflict', current: structuredClone(document) }
      const entries = { ...document.entries, ...request.set }
      for (const key of request.reset ?? []) delete entries[key]
      document = { ...document, revision: (document.revision ?? 0) + 1, entries, updatedAt: 2 }
      return { kind: 'ok', profile: structuredClone(document) }
    },
    accountAgentProfileDelete: async () => { calls.push('delete'); clear(); return { kind: 'ok', profile: structuredClone(document) } },
  }
  /** A clear starts a new generation with no document. */
  function clear() {
    document = { schemaVersion: 1, generation: document.generation + 1, revision: null, entries: {}, updatedAt: null }
  }
  /** Another device clears, and may already have written its copy as the new one. */
  const clearElsewhere = (written: AgentProfile | null = null) => {
    clear()
    if (written) document = { ...document, revision: 1, entries: structuredClone(written), updatedAt: 3 }
  }
  return { requests, calls, document: () => document, failNextGets: (count: number) => { failGets = count }, clearElsewhere }
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

/** An account with no settings, for tests about the profile alone. */
const emptySettingsRequests: Pick<SettingsCloudRequests, 'accountSettingsGet' | 'accountSettingsPatch' | 'accountSettingsDelete'> = {
  accountSettingsGet: async () => ({ kind: 'ok', settings: { schemaVersion: 1, generation: 0, revision: null, settings: {}, updatedAt: null } }),
  accountSettingsPatch: async () => ({ kind: 'offline' }),
  accountSettingsDelete: async () => ({ kind: 'offline' }),
}

function pullingHost(hostId: string): ReachableHost & { api: ReturnType<typeof asHostApi>; fake: FakeApi } {
  const fake = new FakeApi().on('agentProfilePull', () => PULLED).on('agentProfileStatus', () => PULLED)
  return { hostId, api: asHostApi(fake.surface()), fake }
}

/** A file entry as a host reads it, for the fixtures: the phone makes none of its own. */
function fileEntryFromText(provider: 'claude-code' | 'codex', path: string, text: string) {
  const bytes = Buffer.from(text, 'utf8')
  return { kind: 'file' as const, provider, path, contentBase64: bytes.toString('base64'), hash: createHash('sha256').update(bytes).digest('hex') }
}

describe('the local copy', () => {
  test('the local copy keeps it per account, reports it as a local change, and never reports a cloud change back', () => {
    const storage = memoryKeyValueStore()
    const local = new AgentProfileLocalStore(storage)
    local.setAccount(ACCOUNT)
    const reported: unknown[] = []
    local.onLocalChange((change) => reported.push(change))
    const entry = fileEntryFromText('codex', 'prompts/test.md', 'Run the tests.')
    expect(local.setEntry(entry)).toBe('saved')
    expect(reported).toEqual([{ set: { 'file:codex/prompts/test.md': entry }, reset: [] }])
    expect(JSON.parse(storage.getItem('solus.agent-profile.v1:https://app.solus.sh|user-1')!)).toEqual({ entries: { 'file:codex/prompts/test.md': entry } })

    const skill = skillEntryFromRemote({ id: 'acme/skills@review', name: 'review', repo: 'acme/skills', url: 'https://skills.sh/acme/skills/review' })
    local.applyRemote({ set: { 'skill:review': skill }, reset: ['file:codex/prompts/test.md'] })
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

describe('signed in means synced, and hosts pull after this device writes', () => {
  /** A device whose local copy for the account holds `before`, then signs in. */
  function device(cloud = fakeCloud(), before: (local: AgentProfileLocalStore) => void = () => {}) {
    const clock = manualClock()
    const storage = memoryKeyValueStore()
    const local = new AgentProfileLocalStore(storage)
    const hosts = [pullingHost('inst-a'), pullingHost('inst-b')]
    let foreground: (signal: 'foreground') => void = () => {}
    const environment = { ...alwaysOnlineEnvironment, subscribe: (listener: (signal: 'foreground') => void) => { foreground = listener; return () => {} } }
    const sync = new AccountSync(new PersonalSettingsStore(storage), local, { settingsRequests: emptySettingsRequests, profileRequests: cloud.requests, storage: memoryKeyValueStore(), environment, clock }, () => hosts)
    local.setAccount(ACCOUNT)
    before(local)
    sync.followAccount(ACCOUNT)
    const pulls = () => hosts.map((host) => host.fake.callsOf('agentProfilePull').length)
    /** The start that sign-in queued, and what it set off, have settled. */
    const started = async () => { await sync.profileEngine.idle(); await flushPromises() }
    return { cloud, clock, local, hosts, sync, pulls, started, foreground: () => foreground('foreground') }
  }

  test('signing in with no synced profile seeds it with this device’s copy, then every connected host pulls once', async () => {
    const { cloud, sync, pulls, started } = device(fakeCloud(), (local) => local.setEntry(fileEntryFromText('claude-code', 'agents/rules.md', 'Before sign-in.')))
    // Signing in alone starts it; nothing asks the person.
    expect(sync.currentProfile().state).toBe('loading')
    await started()
    expect(cloud.calls).toEqual(['get', 'patch:file:claude-code/agents/rules.md'])
    expect(Object.keys(cloud.document().entries)).toEqual(['file:claude-code/agents/rules.md'])
    expect(sync.currentProfile().state).toBe('synced')
    expect(sync.current().state).toBe('synced')
    expect(pulls()).toEqual([1, 1])
    expect(sync.hostState('inst-a')).toEqual({ status: PULLED, error: null, busy: false })

    // The account notifying again, the same account, starts nothing more.
    sync.followAccount(ACCOUNT)
    await started()
    expect(cloud.calls).toHaveLength(2)
  })

  test('signing in with a synced profile takes it, never this device’s copy, then every connected host pulls once', async () => {
    const synced = { 'file:codex/prompts/test.md': fileEntryFromText('codex', 'prompts/plan.md', 'From the account.') }
    const { cloud, local, sync, pulls, started } = device(fakeCloud(synced), (copy) => copy.setEntry(fileEntryFromText('claude-code', 'agents/rules.md', 'Only here.')))
    await started()
    expect(cloud.calls.filter((call) => call.startsWith('patch'))).toEqual([])
    expect(cloud.document().entries).toEqual(synced)
    // The account wins: its copy replaces this device's, and the entry only this device had goes.
    expect(local.entries()).toEqual(synced)
    expect(sync.currentProfile().state).toBe('synced')
    expect(pulls()).toEqual([1, 1])
  })

  test('a failed start shows in the status and is tried again when the app comes to the front', async () => {
    const cloud = fakeCloud()
    cloud.failNextGets(1)
    const { sync, pulls, started, foreground } = device(cloud)
    await started()
    expect(sync.currentProfile().state).toBe('offline')
    expect(sync.current().state).toBe('offline')
    expect(pulls()).toEqual([0, 0])

    foreground()
    await started()
    expect(sync.currentProfile().state).toBe('synced')
    expect(pulls()).toEqual([1, 1])
  })

  test('a confirmed write pulls each host; signed out, a change pulls none', async () => {
    const { cloud, clock, local, sync, pulls, started } = device(fakeCloud(), (copy) => copy.setEntry(fileEntryFromText('codex', 'prompts/plan.md', 'Start.')))
    await started()
    expect(pulls()).toEqual([1, 1])

    local.setEntry(fileEntryFromText('claude-code', 'agents/rules.md', 'Be brief.'))
    expect(sync.currentProfile().state).toBe('pending')
    expect(pulls()).toEqual([1, 1])
    clock.runAll()
    await started()
    expect(cloud.calls.at(-1)).toBe('patch:file:claude-code/agents/rules.md')
    expect(sync.currentProfile().state).toBe('synced')
    expect(pulls()).toEqual([2, 2])

    // Signed out: local edits stay local, and no host is asked.
    sync.followAccount(null)
    local.setAccount(null)
    local.setEntry(fileEntryFromText('codex', 'prompts/plan.md', 'Local only.'))
    clock.runAll()
    await started()
    expect(sync.currentProfile().state).toBe('signed-out')
    expect(Object.keys(cloud.document().entries).sort()).toEqual(['file:claude-code/agents/rules.md', 'file:codex/prompts/plan.md'])
    expect(pulls()).toEqual([2, 2])
  })

  test('a clear made here starts the synced profile again from this device’s copy at once', async () => {
    const mine = fileEntryFromText('claude-code', 'agents/rules.md', 'This device.')
    const { cloud, sync, pulls, started } = device(fakeCloud(), (local) => local.setEntry(mine))
    await started()
    const generation = cloud.document().generation
    expect(pulls()).toEqual([1, 1])

    expect((await sync.clearProfile()).kind).toBe('cleared')
    await started()
    expect(cloud.document().generation).toBe(generation + 1)
    expect(cloud.calls.slice(-2)).toEqual(['delete', 'patch:file:claude-code/agents/rules.md'])
    expect(cloud.document().entries).toEqual({ 'file:claude-code/agents/rules.md': mine })
    expect(sync.currentProfile().state).toBe('synced')
    expect(pulls()).toEqual([2, 2])
  })

  test('a clear made elsewhere starts sync again at once: seeding when the account is empty, taking the new copy when one is there', async () => {
    const mine = fileEntryFromText('claude-code', 'agents/rules.md', 'This device.')
    const { cloud, local, sync, pulls, started } = device(fakeCloud(), (copy) => copy.setEntry(mine))
    await started()

    // Empty after the clear: this device's copy seeds the new generation.
    cloud.clearElsewhere()
    await sync.profileEngine.refresh()
    await started()
    expect(sync.currentProfile().state).toBe('synced')
    expect(cloud.document().entries).toEqual({ 'file:claude-code/agents/rules.md': mine })
    expect(pulls()).toEqual([2, 2])

    // The clearing device already wrote its copy: this device takes it and sends nothing.
    const theirs = { 'file:codex/prompts/test.md': fileEntryFromText('codex', 'prompts/plan.md', 'Theirs.') }
    cloud.clearElsewhere(theirs)
    const patches = cloud.calls.filter((call) => call.startsWith('patch')).length
    await sync.profileEngine.refresh()
    await started()
    expect(sync.currentProfile().state).toBe('synced')
    expect(cloud.calls.filter((call) => call.startsWith('patch'))).toHaveLength(patches)
    expect(cloud.document().entries).toEqual(theirs)
    expect(local.entries()).toEqual(theirs)
    expect(pulls()).toEqual([3, 3])
  })

  test('a hand-written skill is removed as one change of all its files; a refused entry refuses the whole change', () => {
    const files = [
      fileEntryFromText('claude-code', 'skills/deploy/SKILL.md', '# Deploy'),
      fileEntryFromText('claude-code', 'skills/deploy/scripts/run.sh', 'echo'),
    ]
    const local = new AgentProfileLocalStore(memoryKeyValueStore())
    local.setEntry(files)
    const reported: unknown[] = []
    local.onLocalChange((change) => reported.push(change))
    const [skill] = agentProfileParts(local.entries()).handWrittenSkills
    expect(skill!.keys).toEqual(['file:claude-code/skills/deploy/SKILL.md', 'file:claude-code/skills/deploy/scripts/run.sh'])

    // A refused entry refuses the whole change: nothing is half saved.
    expect(local.setEntry([files[0]!, { kind: 'skill', name: 'bad name!', source: 'acme/skills', skillId: 'x' }])).toBe('invalid')
    expect(reported).toHaveLength(0)

    local.removeKeys(skill!.keys)
    expect(reported).toEqual([{ set: {}, reset: skill!.keys }])
    expect(agentProfileParts(local.entries()).handWrittenSkills).toEqual([])
  })

  test('through the app, only a host that is connected is asked', async () => {
    const cloud = fakeCloud()
    const secrets = memorySecretStore()
    const plane = fakeAccountPlane({ clientId: 'solus-mobile' })
    await seedAccountGrant(secrets, { userId: ACCOUNT.userId, refreshToken: plane.deviceTokens().refresh_token })
    const apis = new Map<string, FakeApi>()
    const transports: FakeTransport[] = []
    // The account answers only once the hosts are up, so the turn-on that sign-in starts meets them connected.
    let answerCloud: () => void = () => {}
    let profileReads = 0
    const cloudGate = new Promise<void>((resolve) => { answerCloud = resolve })
    const app = new SolusApp({
      storage: memoryKeyValueStore(),
      secrets,
      cloudOrigin: ISSUER,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith(ISSUER) && !url.includes('/v1/')) return plane.fetch(url, init)
        const health = /^(http:\/\/[ab]:1)\/health(\?|$)/.exec(url)
        if (health) return Response.json(signedHealth(url, `inst-${health[1]!.slice(7, 8)}`, { name: 'Mac', os: 'macos' }))
        if (url.endsWith('/v1/agent-profile')) {
          profileReads += 1
          await cloudGate
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
    await app.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1', identityKey: identityKeyFor('inst-a') }, 'ta')
    await app.registry.savePaired({ id: 'inst-b', label: 'B', url: 'http://b:1', identityKey: identityKeyFor('inst-b') }, 'tb')
    app.connections.connection('inst-a')
    app.connections.connection('inst-b')
    // Each host proves itself on its http route before the dial goes out.
    await flushPromises()
    await transports[0]!.accept()
    expect(app.connections.state('inst-a')?.readiness).toBe('ready')
    expect(app.connections.state('inst-b')?.readiness).not.toBe('ready')

    // Signed in from an earlier run: no choice is asked; the start is already waiting on the account.
    expect(app.account.isSignedIn).toBe(true)
    await flushPromises()
    expect(profileReads).toBe(1)
    answerCloud()
    await app.accountSync.profileEngine.idle()
    await flushPromises()
    expect(app.accountSync.currentProfile().state).toBe('synced')
    expect(apis.get('inst-a')!.callsOf('agentProfilePull')).toHaveLength(1)
    expect(apis.get('inst-b')!.callsOf('agentProfilePull')).toHaveLength(0)
    // Nothing on either side: synced, with nothing written until an edit.
    expect(cloud.document().revision).toBeNull()
  })
})

describe('the parts the screen shows', () => {
  test('files under skills/ group into one hand-written skill; a probe and a registry result become one entry each', () => {
    const parts = agentProfileParts({
      'file:claude-code/agents/rules.md': fileEntryFromText('claude-code', 'agents/rules.md', 'Hi'),
      'file:claude-code/agents/reviewer.md': fileEntryFromText('claude-code', 'agents/reviewer.md', 'Review'),
      'file:claude-code/skills/deploy/SKILL.md': fileEntryFromText('claude-code', 'skills/deploy/SKILL.md', '# Deploy'),
      'file:claude-code/skills/deploy/scripts/run.sh': fileEntryFromText('claude-code', 'skills/deploy/scripts/run.sh', 'echo'),
      'file:codex/prompts/test.md': fileEntryFromText('codex', 'prompts/plan.md', 'Hi'),
      'skill:review': skillEntryFromRemote({ id: 'acme/skills@review', name: 'review', repo: 'acme/skills', url: 'https://skills.sh/acme/skills/review' }),
      'integration:linear': { kind: 'integration', slug: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: { kind: 'oauth', discover: 'https://mcp.linear.app/.well-known/oauth-protected-resource', registration: 'dynamic' } },
    })
    expect(parts.files.map((entry) => entry.path)).toEqual(['agents/reviewer.md', 'agents/rules.md', 'prompts/plan.md'])
    expect(parts.handWrittenSkills).toEqual([{ name: 'deploy', provider: 'claude-code', keys: ['file:claude-code/skills/deploy/SKILL.md', 'file:claude-code/skills/deploy/scripts/run.sh'] }])
    expect(parts.registrySkills.map((skill) => `${skill.source}@${skill.skillId}`)).toEqual(['acme/skills@review'])
    expect(parts.integrations.map((integration) => integration.slug)).toEqual(['linear'])

    const signals: never[] = []
    expect(integrationEntryFromProbe('https://mcp.example.com/mcp ', { outcome: 'credentials-required', auth: { kind: 'bearer', scheme: 'bearer' }, signals }))
      .toEqual({ kind: 'integration', slug: 'mcp-example-com', name: 'mcp.example.com', url: 'https://mcp.example.com/mcp', auth: { kind: 'bearer', scheme: 'bearer' }, disabledTools: [] })
    expect(integrationEntryFromProbe('https://x.example', { outcome: 'undetermined', reason: 'not_mcp', signals })).toBeNull()
  })

  test('a conflict row names the entry and each side; a host line says where its copy came from', () => {
    const mine = { 'file:claude-code/agents/rules.md': fileEntryFromText('claude-code', 'agents/rules.md', 'Be  brief.\n') }
    expect(entryKeyLabel('file:claude-code/agents/rules.md')).toBe('agents/rules.md (Claude Code)')
    expect(entryKeyLabel('skill:review')).toBe('Skill review')
    expect(entryValueText(mine, 'file:claude-code/agents/rules.md')).toBe('Be brief.')
    expect(entryValueText({}, 'file:claude-code/agents/rules.md')).toBe('Removed')
    expect(hostProfileText(PULLED, null, (ms) => `at ${ms}`)).toBe('Copied from your account at 5: 1 file.')
    expect(hostProfileText({ ...PULLED, syncedAt: null }, null, String)).toBe('Not on this host yet.')
    expect(hostProfileText(null, 'Refused.', String)).toBe('Refused.')
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

describe('a profile server on the chosen host', () => {
  const entry = {
    kind: 'integration' as const, slug: 'planetscale', name: 'PlanetScale', url: 'https://mcp.pscale.dev/mcp/planetscale',
    auth: { kind: 'oauth' as const, discover: 'https://mcp.pscale.dev/.well-known/oauth-protected-resource/mcp/planetscale', registration: 'dynamic' as const },
  }
  const onHost = {
    id: 'int-1', organizationId: 'local', ownerKey: 'person', kind: 'mcp' as const, slug: 'planetscale', name: 'PlanetScale',
    url: entry.url, auth: entry.auth, disabledTools: [], createdBy: null, createdAt: '', updatedAt: '',
  }
  const list = { kind: 'loaded' as const, integrations: [onHost] }

  test('a synced server with no sign-in on the host says so and offers Connect, as the desktop does', () => {
    expect(profileServerStatus(entry, list, { kind: 'loaded', byIntegration: new Map() })).toEqual({ text: 'Not connected', tone: 'muted', action: 'connect' })
  })

  test('a sign-in in the account reads as connected', () => {
    const byIntegration = new Map([['int-1', { integrationId: 'int-1', status: 'connected' as const, source: 'cloud' as const, label: null, info: null, error: null, updatedAt: '' }]])
    expect(profileServerStatus(entry, list, { kind: 'loaded', byIntegration })).toEqual({ text: 'Connected in your Solus account', tone: 'muted', action: null })
  })

  test('a host without the server yet, and a host that cannot list servers', () => {
    expect(profileServerStatus(entry, { kind: 'loaded', integrations: [] }, { kind: 'loading' })).toMatchObject({ text: 'Not added yet', action: 'connect' })
    expect(profileServerStatus(entry, { kind: 'unsupported' }, { kind: 'unsupported' })).toBeNull()
  })
})
