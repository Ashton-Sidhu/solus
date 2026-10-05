import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SavedWorkspace } from '@solus/client-core/workspace-registry'
import { notificationSources } from '@solus/client-core/notifications/sources'
import { ambiguousOrganizationIds, savedWorkspaceFor, saveDirectoryWorkspaces } from '@solus/client-core/workspace-registry'
import { DEFAULT_ORGANIZATION_POLICY } from '@solus/contracts/uplink'

// plans/015-notifications-hub.md §4, stage 4: the hub reads every host and every
// organization home the directory lists, not the window's organization alone. A
// host is one source however many routes reach it. An organization id two
// directories list names no single service: the registry dials neither, and the
// hub shows a conflict instead of reading one service's records as the other's.

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const originalLocalStorage = globalThis.localStorage
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true }) })
afterEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true }) })

const policy = DEFAULT_ORGANIZATION_POLICY
const workspace = (organizationId: string, directoryUrl: string, label = organizationId): SavedWorkspace => ({
  organizationId, label, routes: [{ kind: 'tunnel', url: `${directoryUrl}/tunnel` }], isActive: false, policy, directoryUrl,
})

describe('notification sources', () => {
  test('every host and every organization home is a source, whatever the window selected', () => {
    const { sources, conflicts } = notificationSources(
      [{ serverId: 'local', label: 'This Mac', installationId: 'inst-mac' }, { serverId: 'vm-1', label: 'VM one' }, { serverId: 'vm-2', label: 'VM two' }],
      [workspace('org-a', 'https://app.solus.sh'), workspace('org-b', 'https://app.solus.sh')],
    )
    expect(sources.map((source) => [source.sourceId, source.kind])).toEqual([
      ['host:inst-mac', 'host'], ['host:vm-1', 'host'], ['host:vm-2', 'host'],
      ['workspace:org-a', 'organization'], ['workspace:org-b', 'organization'],
    ])
    expect(conflicts).toEqual([])
  })

  test('two routes to one installation are one source', () => {
    const { sources } = notificationSources([
      { serverId: 'vm-lan', label: 'VM (LAN)', installationId: 'inst-vm' },
      { serverId: 'vm-tunnel', label: 'VM (tunnel)', installationId: 'inst-vm' },
    ], [])
    expect(sources.map((source) => source.serverId)).toEqual(['vm-lan'])
  })

  test('an organization id two directories list is a conflict, never a source, and the registry dials neither', () => {
    const cloud = workspace('org-same', 'https://app.solus.sh', 'Cloud')
    const selfHosted = workspace('org-same', 'https://solus.example.com', 'Self-hosted')
    const { sources, conflicts } = notificationSources([], [cloud, selfHosted, workspace('org-other', 'https://app.solus.sh')])
    expect(sources.map((source) => source.sourceId)).toEqual(['workspace:org-other'])
    expect(conflicts).toEqual(['org-same'])

    saveDirectoryWorkspaces([cloud], cloud.directoryUrl)
    expect(savedWorkspaceFor('workspace:org-same')?.label).toBe('Cloud')
    saveDirectoryWorkspaces([selfHosted], selfHosted.directoryUrl)
    // The transport cannot be pointed at either service by the shared id.
    expect(savedWorkspaceFor('workspace:org-same')).toBeNull()
    expect(ambiguousOrganizationIds([cloud, selfHosted])).toEqual(new Set(['org-same']))
    // One directory listing an organization once is never ambiguous.
    expect(ambiguousOrganizationIds([cloud, cloud])).toEqual(new Set())
  })
})
