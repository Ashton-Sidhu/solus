import { describe, expect, test } from 'bun:test'
import { notificationSources } from '@solus/client-core/notifications/sources'
import { ambiguousOrganizationIds, workspaceFor, type KnownWorkspace } from '@solus/client-core/workspace-registry'
import { DEFAULT_HOST_RULES } from '@solus/contracts/uplink'

// plans/015-notifications-hub.md §4, stage 4: the hub reads every host and every
// organization home the directory lists, not the window's organization alone. A
// host is one source however many routes reach it. An organization id two
// directories list names no single service: the registry dials neither, and the
// hub shows a conflict instead of reading one service's records as the other's.

const hostRules = DEFAULT_HOST_RULES
const workspace = (organizationId: string, directoryUrl: string, label = organizationId): KnownWorkspace => ({
  organizationId, label, routes: [{ kind: 'tunnel', url: `${directoryUrl}/tunnel` }], isActive: false, hostRules, directoryUrl,
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

  test('two installations with one machine name say which host each is', () => {
    // An old install on the same machine keeps the machine's name. Without the
    // address, its "unreachable" notice reads as a fault of the machine in use.
    const { sources } = notificationSources([
      { serverId: 'local', label: 'Mac mini', installationId: 'inst-new', isLocal: true, url: 'http://127.0.0.1:3001' },
      { serverId: 'old', label: 'Mac mini', installationId: 'inst-old', url: 'http://100.87.157.17:55640' },
      { serverId: 'vm', label: 'VM', installationId: 'inst-vm', url: 'http://10.0.0.2:3001' },
    ], [])
    expect(sources.map((source) => source.label)).toEqual(['Mac mini (this device)', 'Mac mini (100.87.157.17:55640)', 'VM'])
  })

  test('an organization id two directories list is a conflict, never a source, and the registry dials neither', () => {
    const cloud = workspace('org-same', 'https://app.solus.sh', 'Cloud')
    const selfHosted = workspace('org-same', 'https://solus.example.com', 'Self-hosted')
    const { sources, conflicts } = notificationSources([], [cloud, selfHosted, workspace('org-other', 'https://app.solus.sh')])
    expect(sources.map((source) => source.sourceId)).toEqual(['workspace:org-other'])
    expect(conflicts).toEqual(['org-same'])

    expect(workspaceFor([cloud], 'workspace:org-same')?.label).toBe('Cloud')
    // The transport cannot be pointed at either service by the shared id.
    expect(workspaceFor([cloud, selfHosted], 'workspace:org-same')).toBeNull()
    expect(ambiguousOrganizationIds([cloud, selfHosted])).toEqual(new Set(['org-same']))
    // One directory listing an organization once is never ambiguous.
    expect(ambiguousOrganizationIds([cloud, cloud])).toEqual(new Set())
  })
})
