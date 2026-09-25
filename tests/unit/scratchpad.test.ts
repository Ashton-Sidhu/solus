import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import type { SeatStatus } from '@solus/contracts/seats'
import type { RunConfig, ServerCapabilities } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'
import { projectDirLabel, SCRATCHPAD_LABEL } from '@solus/workspace-ui/lib/paths'
import { scratchpadCheckout } from '@solus/workspace-ui/components/input/lib/project-chip-options'
import { chooseChatHost, type ChatHost } from '@solus/workspace-ui/contexts/projects/chat-host-rule'
import { seatNeeded } from '@solus/workspace-ui/contexts/seats/seat-need'

// Scratchpad (docs/projects.md): the place a session with no project runs.
// Each host — and each member on a shared host — names its own chat folder, so
// every rule here asks the host that owns the path, never one global folder.

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: singleHostServerConnections(),
}))
mock.module('@solus/workspace-ui/contexts/connections/host-roles.store.svelte', () => ({
  // The organization's workspace service runs no sessions; every machine does.
  hostRolesStore: { hasExecution: (serverId: string) => serverId !== 'workspace-service' },
}))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let ConnectionsStore: typeof import('@solus/workspace-ui/contexts/connections/connections.store.svelte')['ConnectionsStore']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  ;({ ConnectionsStore } = await import('@solus/workspace-ui/contexts/connections/connections.store.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function capabilities(workspacePath?: string): ServerCapabilities {
  return {
    headless: true,
    desktopHandlers: false,
    agents: { claude: true, codex: true },
    dictation: false,
    platform: 'linux',
    version: 'test',
    projectCount: 0,
    agentAuth: { claude: true },
    gitAuth: { github: true },
    ...(workspacePath ? { workspacePath } : {}),
  } as ServerCapabilities
}

async function storeWith(hosts: Record<string, string | undefined>) {
  const store = new ConnectionsStore()
  for (const [serverId, workspacePath] of Object.entries(hosts)) {
    const api = asHostApi({ getServerCapabilities: async () => capabilities(workspacePath) })
    await store.refreshCapabilities({ serverId, api })
  }
  return store
}

const LAPTOP_CHAT = '/Users/me/.solus/my-workspace'
const SPRITE_CHAT = '/data/projects/user-1/.chat'

describe('the Scratchpad label', () => {
  test('a chat on a host other than the primary one reads "Scratchpad"', async () => {
    // WHY (G6): the label used to compare against the primary host's folder
    // alone, so a chat on the Sprite showed a raw `.chat` path.
    const store = await storeWith({ local: LAPTOP_CHAT, sprite: SPRITE_CHAT })
    expect(projectDirLabel(SPRITE_CHAT, store.chatFolderFor('sprite'))).toBe(SCRATCHPAD_LABEL)
    expect(projectDirLabel(`${SPRITE_CHAT}/`, store.chatFolderFor('sprite'))).toBe(SCRATCHPAD_LABEL)
  })

  test('a project, or another host\'s chat folder, keeps its own name', async () => {
    const store = await storeWith({ local: LAPTOP_CHAT, sprite: SPRITE_CHAT })
    expect(projectDirLabel('/data/projects/user-1/web', store.chatFolderFor('sprite'))).toBe('web')
    // The same path means a different folder on a different machine.
    expect(projectDirLabel(LAPTOP_CHAT, store.chatFolderFor('sprite'))).toBe('my-workspace')
  })

  test('a host that runs no sessions has no Scratchpad', async () => {
    const store = await storeWith({ 'workspace-service': SPRITE_CHAT })
    expect(store.chatFolderFor('workspace-service')).toBeNull()
  })
})

function run(serverId: string, pendingServerId?: string): Pick<RunConfig, 'serverId' | 'pendingHostDispatch'> {
  return {
    serverId,
    pendingHostDispatch: pendingServerId ? { serverId: pendingServerId, intent: 'open-project' } : null,
  }
}

describe('the project chip\'s Scratchpad row', () => {
  test('aims at the chat folder of the Run-on host, not the client\'s own machine', async () => {
    // WHY (G1): the row once needed a local host and always aimed there, so web,
    // mobile, and a Solus Cloud origin had no row at all.
    const store = await storeWith({ local: LAPTOP_CHAT, sprite: SPRITE_CHAT })
    const chatFolderFor = (serverId: string) => store.chatFolderFor(serverId)
    expect(scratchpadCheckout(run('sprite'), chatFolderFor)).toEqual({ serverId: 'sprite', projectRoot: SPRITE_CHAT })
    // A run headed for another host shows that host's Scratchpad.
    expect(scratchpadCheckout(run('local', 'sprite'), chatFolderFor)).toEqual({ serverId: 'sprite', projectRoot: SPRITE_CHAT })
  })

  test('is hidden when the Run-on host offers no Scratchpad', async () => {
    // WHY: a host whose chat folder is inside a Git work tree omits it; the
    // row must not aim a chat at another host's folder instead.
    const store = await storeWith({ local: LAPTOP_CHAT, checkout: undefined })
    expect(scratchpadCheckout(run('checkout'), (serverId) => store.chatFolderFor(serverId))).toBeNull()
  })
})

const laptop: ChatHost = { serverId: 'local', online: true, managed: false, local: true }
const sprite: ChatHost = { serverId: 'sprite', online: true, managed: true, local: false }
const studio: ChatHost = { serverId: 'studio', online: true, managed: false, local: false }
const none = { atCloudOrigin: false, lastChatServerId: null, defaultServerId: null }

describe('the Just chat host (S6)', () => {
  test('at a Solus Cloud origin: the organization\'s managed host', () => {
    expect(chooseChatHost([studio, sprite], { ...none, atCloudOrigin: true, defaultServerId: 'studio' })).toBe('sprite')
  })

  test('a stopped managed host is still the cloud choice', () => {
    expect(chooseChatHost([studio, { ...sprite, online: false }], { ...none, atCloudOrigin: true })).toBe('sprite')
  })

  test('on desktop: this computer', () => {
    expect(chooseChatHost([sprite, laptop, studio], { ...none, defaultServerId: 'studio' })).toBe('local')
  })

  test('the host last used for a chat wins while it is up', () => {
    expect(chooseChatHost([laptop, studio, sprite], { ...none, atCloudOrigin: true, lastChatServerId: 'studio' })).toBe('studio')
  })

  test('a last-used host that is down falls back to the rule', () => {
    // WHY: a chat must not wait on a machine that is asleep.
    expect(chooseChatHost([laptop, { ...studio, online: false }], { ...none, lastChatServerId: 'studio' })).toBe('local')
    expect(chooseChatHost([{ ...studio, online: false }, sprite], { ...none, atCloudOrigin: true, lastChatServerId: 'studio' })).toBe('sprite')
  })

  test('web to your own machine: the default host; nothing when no host can run', () => {
    expect(chooseChatHost([studio], { ...none, defaultServerId: 'studio' })).toBe('studio')
    expect(chooseChatHost([], { ...none, defaultServerId: 'studio' })).toBeNull()
  })
})

function seat(provider: SeatStatus['provider'], state: SeatStatus['state']): SeatStatus {
  return { provider, state, usageCapable: true }
}

describe('seat state before send (S7)', () => {
  test('a member with no seat for the chosen agent needs one', () => {
    expect(seatNeeded(true, [seat('claude-code', 'none'), seat('codex', 'connected')], 'claude-code')).toBe(true)
    expect(seatNeeded(true, [seat('claude-code', 'expired')], 'claude-code')).toBe(true)
    expect(seatNeeded(true, [], 'codex')).toBe(true)
  })

  test('a connected seat for the chosen agent needs nothing', () => {
    expect(seatNeeded(true, [seat('claude-code', 'none'), seat('codex', 'connected')], 'codex')).toBe(false)
  })

  test('a host that does not give this client seats never asks', () => {
    // WHY: the owner's turns run on the host login, and a personal host has no
    // seats at all; a "Connect" there would be a false alarm.
    expect(seatNeeded(false, [seat('claude-code', 'none')], 'claude-code')).toBe(false)
    expect(seatNeeded(undefined, undefined, 'claude-code')).toBe(false)
  })

  test('before the host lists the seats, the notice does not guess', () => {
    expect(seatNeeded(true, undefined, 'claude-code')).toBe(false)
  })
})
