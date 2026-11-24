import { describe, expect, test } from 'bun:test'
import type { HostPersonalSettings, PersonalSettingsPatch } from '@solus/contracts/settings'
import type { AgentProfile, AgentProfileDocumentPatch } from '@solus/contracts/agent-profile'
import { followPersonalDocumentHosts } from '../../apps/mobile/solus-core/features/settings/personal-document-hosts'
import { AgentProfileLocalStore } from '../../apps/mobile/solus-core/features/settings/agent-profile-local'
import { PersonalSettingsStore } from '../../apps/mobile/solus-core/features/settings/personal-settings'
import { Listeners } from '../../apps/mobile/solus-core/lib/listeners'
import { memoryKeyValueStore } from '../../apps/mobile/solus-core/platform/ports'

// ADR 0007 on the phone: signed out, the phone shows the settings of its first
// host and writes there; signed in, it writes the account's copy to a host that
// holds no token for the person.

/** One connected host: its copy of the person's settings, and the events it sends. */
function phoneHost(hostId: string, copy: Partial<HostPersonalSettings> = {}) {
  const state: HostPersonalSettings = { settings: {}, source: 'host', followsAccount: false, accountRevision: null, updatedAt: null, syncSettings: true, ...copy }
  const patches: PersonalSettingsPatch[] = []
  const profile: { entries: AgentProfile } = { entries: {} }
  const handlers = new Set<(payload: { kind: 'settings' | 'agent-profile' }) => void>()
  return {
    state,
    patches,
    profile,
    changedHere: () => { for (const handler of handlers) handler({ kind: 'settings' }) },
    connection: {
      hostId,
      api: {
        personalSettingsGet: async () => structuredClone(state),
        personalSettingsChanged: async () => structuredClone(state),
        agentProfileDocumentGet: async () => ({ entries: structuredClone(profile.entries), updatedAt: 1 }),
        agentProfileDocumentPatch: async (change: AgentProfileDocumentPatch) => {
          for (const key of change.reset) delete profile.entries[key]
          Object.assign(profile.entries, structuredClone(change.set))
          return { entries: structuredClone(profile.entries), updatedAt: 2 }
        },
        personalSettingsPatch: async (change: PersonalSettingsPatch) => {
          patches.push(structuredClone(change))
          for (const key of change.reset) delete state.settings[key]
          Object.assign(state.settings, structuredClone(change.set))
          return { settings: structuredClone(state), ignored: [] }
        },
      },
      events: {
        subscribe: (_topic: string, handler: (payload: { kind: 'settings' | 'agent-profile' }) => void) => {
          handlers.add(handler)
          return () => { handlers.delete(handler) }
        },
      },
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function phone(hosts: ReturnType<typeof phoneHost>[], onPersonalChange?: (fromHostId: string | null, change: PersonalSettingsPatch) => void) {
  const storage = memoryKeyValueStore()
  const personal = new PersonalSettingsStore(storage)
  const agentProfile = new AgentProfileLocalStore(storage)
  const connectionChanges = new Listeners()
  const settingsCopyChanges = new Listeners()
  const stop = followPersonalDocumentHosts({
    personal,
    agentProfile,
    // SAFETY: the wiring reads only `hostId`, `api`, and `events.subscribe` of a connection; each is given here.
    readyConnections: () => hosts.map((host) => host.connection) as never,
    connectionChanges,
    defaultHostId: () => hosts[0]?.connection.hostId ?? null,
    settingsCopyChanges,
    storage,
    onPersonalChange,
  })
  return { personal, agentProfile, connectionChanges, settingsCopyChanges, stop }
}

describe('the phone and the source of the settings', () => {
  test('signed out, the phone shows its first host’s settings, names that host, and writes its changes there', async () => {
    const first = phoneHost('first', { settings: { themeMode: 'dark' } })
    const second = phoneHost('second', { settings: { themeMode: 'light' } })
    const { personal, stop } = phone([first, second])
    await settle()
    expect(personal.current().themeMode).toBe('dark')
    expect(personal.homeHostId()).toBe('first')

    personal.set({ extraInstructions: 'From the phone.' })
    await settle()
    expect(first.state.settings).toEqual({ themeMode: 'dark', extraInstructions: 'From the phone.' })
    expect(second.patches).toEqual([])

    // Another client changed the copy on the first host: the phone reads it again.
    first.state.settings = { themeMode: 'light' }
    first.changedHere()
    await settle()
    expect(personal.current().themeMode).toBe('light')
    stop()
  })

  test('signed in, a host with no token for the person gets the account copy from the phone', async () => {
    const tokenless = phoneHost('tokenless', { settings: { fontSize: 20 } })
    const { personal, settingsCopyChanges, stop } = phone([tokenless])
    await settle()
    personal.setAccount({ origin: 'https://solus.test', userId: 'user-a' })
    // A first sign-in starts from the host's copy (ADR 0007 decision 3); here the account's copy then differs from it.
    expect(personal.current().fontSize).toBe(20)
    personal.applyRemote({ set: { themeMode: 'dark' }, reset: ['fontSize'] })
    settingsCopyChanges.notify()
    await settle()
    expect(personal.homeHostId()).toBeNull()
    expect(tokenless.state.settings).toEqual({ themeMode: 'dark' })
    expect(tokenless.patches.at(-1)?.reset).toEqual(['fontSize'])
    stop()
  })

  test('signed out, the agent profile list is the first host’s too', async () => {
    // WHY: ADR 0007 decision 6: the agent profile follows the same rule as the settings.
    const deploy = { 'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' } } as const satisfies AgentProfile
    const first = phoneHost('first')
    first.profile.entries = structuredClone(deploy)
    const { agentProfile, stop } = phone([first])
    await settle()
    expect(agentProfile.entries()).toEqual(deploy)

    agentProfile.removeKeys(['skill:deploy'])
    await settle()
    expect(first.profile.entries).toEqual({})

    first.profile.entries = structuredClone(deploy)
    first.changedHere()
    await settle()
    // The settings event names its kind: an agent profile change is read by the profile only.
    expect(agentProfile.entries()).toEqual({})
    stop()
  })
})

describe('Settings on one host (docs/plans/settings-sync-hosts.md decision 7)', () => {
  test("while Settings shows one host, the phone shows that host's copy and writes there; then the first host's again", async () => {
    // WHY: a person must be able to change a host whose Sync settings is off, and see what it holds.
    const first = phoneHost('first', { settings: { themeMode: 'dark' } })
    const second = phoneHost('second', { settings: { themeMode: 'light' } })
    const spread: Array<string | null> = []
    const { personal, stop } = phone([first, second], (fromHostId) => spread.push(fromHostId))
    await settle()
    personal.showSettingsHost('second')
    await settle()
    expect(personal.current().themeMode).toBe('light')
    personal.set({ extraInstructions: 'On the second host.' })
    await settle()
    expect(second.state.settings).toEqual({ themeMode: 'light', extraInstructions: 'On the second host.' })
    expect(first.state.settings).toEqual({ themeMode: 'dark' })
    // The change is offered to Sync settings as a change on the host it was made on.
    expect(spread).toEqual(['second'])
    personal.showSettingsHost(null)
    await settle()
    expect(personal.current().themeMode).toBe('dark')
    stop()
  })
})
