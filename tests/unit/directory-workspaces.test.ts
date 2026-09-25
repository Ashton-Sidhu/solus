import { describe, expect, test } from 'bun:test'
import { directoryHostsOf, directoryResponseSchema, directoryWorkspacesOf, type DirectoryHost } from '@solus/contracts/uplink'
import { mergeDirectoryIntoSaved } from '@solus/client-core/uplink-session'

// docs/plans/workspace-and-machines.md §4. WHY: the workspace service was a
// `cloud` host row beside the machines, and the client took it for a host.
// The directory now lists workspaces apart; while both are sent, a client of
// either age must keep the same saved rows.

const machine: DirectoryHost = {
  hostId: 'h1', installationId: 'managed:h1', label: 'Cloud · Acme', kind: 'managed', organizationId: 'org-1',
  routes: [{ kind: 'tunnel', url: 'https://h1.solus.test' }], managedState: 'ready',
}
const cloudRows: DirectoryHost[] = [
  { hostId: 'workspace:org-1', installationId: 'workspace:org-1', label: 'Acme', kind: 'cloud', organizationId: 'org-1', routes: [{ kind: 'tunnel', url: 'https://workspace.solus.test' }], isActiveWorkspace: true },
  { hostId: 'workspace:org-2', installationId: 'workspace:org-2', label: 'Beta', kind: 'cloud', organizationId: 'org-2', routes: [{ kind: 'tunnel', url: 'https://workspace.solus.test' }] },
]

describe('the directory\'s workspaces', () => {
  test('become the same cloud rows a client saved from the host list', () => {
    const both = directoryResponseSchema.parse({ hosts: [machine, ...cloudRows], workspaces: directoryWorkspacesOf([machine, ...cloudRows]) })
    const old = directoryResponseSchema.parse({ hosts: [machine, ...cloudRows] })
    expect(directoryHostsOf(both)).toEqual(directoryHostsOf(old))
    expect(mergeDirectoryIntoSaved([], directoryHostsOf(both), 'https://app.solus.test', 1))
      .toEqual(mergeDirectoryIntoSaved([], directoryHostsOf(old), 'https://app.solus.test', 1))
  })

  test('are the authority when sent, and machines alone come from the host list', () => {
    const response = directoryResponseSchema.parse({
      hosts: [machine, cloudRows[1]],
      workspaces: [{ organizationId: 'org-1', label: 'Acme', routes: cloudRows[0].routes, isActive: true }],
    })
    expect(directoryHostsOf(response).map((host) => host.hostId)).toEqual(['h1', 'workspace:org-1'])
  })

  test('a malformed list reads as absent, and the cloud rows stand', () => {
    const response = directoryResponseSchema.parse({ hosts: [machine, ...cloudRows], workspaces: [{ label: 'no organization' }] })
    expect(response.workspaces).toBeUndefined()
    expect(directoryHostsOf(response)).toEqual([machine, ...cloudRows])
  })
})
