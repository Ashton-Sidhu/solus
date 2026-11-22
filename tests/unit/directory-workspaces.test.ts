import { beforeEach, describe, expect, test } from 'bun:test'
import { windowOrganizationSelection } from '@solus/client-core/organization-selection'
import { DEFAULT_HOST_RULES, directoryResponseSchema, type DirectoryHost, type DirectoryWorkspace } from '@solus/contracts/uplink'
import type { HostCatalog } from '@solus/client-core/host-catalog'
import { activeWorkspace, workspaceTarget } from '@solus/client-core/workspace-registry'
import { catalogOf, fakeDirectory, fakeList, memoryCredentials } from './helpers/host-catalog-world'

// docs/plans/workspace-and-machines.md §4. WHY: a workspace service is a cloud
// service, never a host. A fresh account on its first sign-in logged "hosts: 1"
// before it linked any machine, because the client folded the organization's
// workspace service into the saved hosts.

const DIRECTORY = 'https://app.solus.test'
let directory = fakeDirectory(DIRECTORY)
let catalog: HostCatalog = catalogOf({ credentials: memoryCredentials([]), directory })

beforeEach(async () => {
  windowOrganizationSelection.reconcile([])
  directory = fakeDirectory(DIRECTORY)
  catalog = catalogOf({ credentials: memoryCredentials([]), directory })
  await catalog.useListSource(fakeList([], 'account').source)
})

const acme: DirectoryWorkspace = { organizationId: 'org-1', label: 'Acme', routes: [{ kind: 'tunnel', url: 'https://workspace.solus.test' }], isActive: true, hostRules: DEFAULT_HOST_RULES }
const beta: DirectoryWorkspace = { organizationId: 'org-2', label: 'Beta', routes: [{ kind: 'tunnel', url: 'https://workspace.solus.test' }], isActive: false, hostRules: DEFAULT_HOST_RULES }
const machine: DirectoryHost = {
  hostId: 'h1', installationId: 'inst-1', label: 'Studio Mac', kind: 'personal', category: 'personal', ownerUserId: 'me',
  routes: [{ kind: 'tunnel', url: 'https://h1.solus.test' }],
  organizationIds: [],
}

/** One directory read. */
async function adopt(answer: { hosts: DirectoryHost[]; workspaces: DirectoryWorkspace[] }): Promise<void> {
  directory.answer(answer.hosts, answer.workspaces)
  await catalog.refreshDirectory()
}

describe('the directory\'s workspace services', () => {
  test('a fresh account has no host, only its organization\'s workspace service', async () => {
    await adopt(directoryResponseSchema.parse({ hosts: [], workspaces: [acme] }))
    expect(catalog.hosts()).toEqual([])
    expect(catalog.workspaces().map((workspace) => workspace.organizationId)).toEqual(['org-1'])
  })

  test('linking a machine adds one host and leaves the workspaces apart', async () => {
    await adopt({ hosts: [], workspaces: [acme] })
    await adopt({ hosts: [machine], workspaces: [acme] })
    expect(catalog.hosts().map((host) => host.id)).toEqual(['inst-1'])
    expect(catalog.workspaces()).toHaveLength(1)
  })

  test('the window keeps its organization until the directory drops it', async () => {
    await adopt({ hosts: [], workspaces: [acme, beta] })
    expect(activeWorkspace(catalog.workspaces())?.organizationId).toBe('org-1')
    await adopt({ hosts: [], workspaces: [{ ...acme, isActive: false }, { ...beta, isActive: true }] })
    expect(activeWorkspace(catalog.workspaces())?.organizationId).toBe('org-1')
    await adopt({ hosts: [], workspaces: [{ ...beta, isActive: true }] })
    expect(catalog.workspaces().map((workspace) => workspace.organizationId)).toEqual(['org-2'])
  })

  test('a failed read keeps the workspaces the last read listed', async () => {
    await adopt({ hosts: [], workspaces: [acme] })
    directory.state.answer = null
    await catalog.refreshDirectory()
    expect(catalog.workspaces().map((workspace) => workspace.organizationId)).toEqual(['org-1'])
  })

  test('malformed or missing directory facts are rejected instead of guessed', () => {
    expect(directoryResponseSchema.safeParse({ hosts: [machine], workspaces: [{ label: 'no organization' }] }).success).toBe(false)
    for (const field of ['category', 'kind', 'organizationIds']) {
      const invalid = Object.fromEntries(Object.entries(machine).filter(([key]) => key !== field))
      expect(directoryResponseSchema.safeParse({ hosts: [invalid], workspaces: [acme] }).success).toBe(false)
    }
    expect(directoryResponseSchema.safeParse({ hosts: [machine], workspaces: [{ ...acme, hostRules: { allowsCloudHosts: 'yes' } }] }).success).toBe(false)
    expect(directoryResponseSchema.safeParse({ hosts: [machine], workspaces: [{ ...acme, hostRules: undefined }] }).success).toBe(false)
  })

  test('a workspace is dialed on its tunnel alone, with a grant for its own id', async () => {
    await adopt({ hosts: [], workspaces: [{ ...acme, routes: [{ kind: 'lan', url: 'http://10.0.0.1:1' }, ...acme.routes] }] })
    expect(workspaceTarget(catalog.workspaceFor('workspace:org-1')!)).toEqual({
      id: 'workspace:org-1',
      label: 'Acme',
      url: 'https://workspace.solus.test',
      local: false,
      routes: [{ kind: 'tunnel', url: 'https://workspace.solus.test' }],
      uplink: { hostId: 'workspace:org-1', directoryUrl: DIRECTORY, organizationIds: ['org-1'] },
    })
  })

  test('the window\'s choice picks the active workspace; a choice the directory dropped falls back', async () => {
    // WHY (organization-scope §2, §7): each window selects one organization, and the
    // account's active mark only seeds a window that has not chosen.
    await adopt({ hosts: [], workspaces: [acme, beta] })
    windowOrganizationSelection.set('org-2')
    expect(activeWorkspace(catalog.workspaces())?.organizationId).toBe('org-2')
    await adopt({ hosts: [], workspaces: [acme] })
    expect(activeWorkspace(catalog.workspaces())?.organizationId).toBe('org-1')
  })
})
