import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { windowOrganizationSelection } from '@solus/client-core/organization-selection'
import { DEFAULT_ORGANIZATION_POLICY, directoryResponseSchema, type DirectoryHost, type DirectoryWorkspace } from '@solus/contracts/uplink'
import { loadServers, saveServers } from '@solus/client-core/server-registry'
import { mergeDirectoryIntoSaved } from '@solus/client-core/uplink-session'
import { activeWorkspace, loadWorkspaces, saveDirectoryWorkspaces, workspaceTarget } from '@solus/client-core/workspace-registry'

// docs/plans/workspace-and-machines.md §4. WHY: a workspace service is a cloud
// service, never a host. A fresh account on its first sign-in logged "hosts: 1"
// before it linked any machine, because the client folded the organization's
// workspace service into the saved hosts.

const DIRECTORY = 'https://app.solus.test'
const previousLocalStorage = globalThis.localStorage
const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  windowOrganizationSelection.reconcile([])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  })
})

afterEach(() => {
  if (previousLocalStorage === undefined) {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: previousLocalStorage })
  }
})

const acme: DirectoryWorkspace = { organizationId: 'org-1', label: 'Acme', routes: [{ kind: 'tunnel', url: 'https://workspace.solus.test' }], isActive: true, policy: DEFAULT_ORGANIZATION_POLICY }
const beta: DirectoryWorkspace = { organizationId: 'org-2', label: 'Beta', routes: [{ kind: 'tunnel', url: 'https://workspace.solus.test' }], isActive: false, policy: DEFAULT_ORGANIZATION_POLICY }
const machine: DirectoryHost = {
  hostId: 'h1', installationId: 'inst-1', label: 'Studio Mac', kind: 'personal', category: 'personal', ownerUserId: 'me',
  routes: [{ kind: 'tunnel', url: 'https://h1.solus.test' }],
  organizationIds: [],
}

/** What a client does with one directory read. */
function adopt(directory: { hosts: DirectoryHost[]; workspaces: DirectoryWorkspace[] }): void {
  saveServers(mergeDirectoryIntoSaved(loadServers(), directory.hosts, DIRECTORY, 1))
  saveDirectoryWorkspaces(directory.workspaces, DIRECTORY)
}

describe('the directory\'s workspace services', () => {
  test('a fresh account saves no host, only its organization\'s workspace service', () => {
    adopt(directoryResponseSchema.parse({ hosts: [], workspaces: [acme] }))
    expect(loadServers()).toEqual([])
    expect(loadWorkspaces().map((workspace) => workspace.organizationId)).toEqual(['org-1'])
  })

  test('linking a machine adds one host and leaves the workspaces apart', () => {
    adopt({ hosts: [], workspaces: [acme] })
    adopt({ hosts: [machine], workspaces: [acme] })
    expect(loadServers().map((server) => server.id)).toEqual(['inst-1'])
    expect(loadWorkspaces()).toHaveLength(1)
  })

  test('the window keeps its organization until the directory drops it', () => {
    adopt({ hosts: [], workspaces: [acme, beta] })
    expect(activeWorkspace(loadWorkspaces())?.organizationId).toBe('org-1')
    adopt({ hosts: [], workspaces: [{ ...acme, isActive: false }, { ...beta, isActive: true }] })
    expect(activeWorkspace(loadWorkspaces())?.organizationId).toBe('org-1')
    adopt({ hosts: [], workspaces: [{ ...beta, isActive: true }] })
    expect(loadWorkspaces().map((workspace) => workspace.organizationId)).toEqual(['org-2'])
  })

  test('another directory origin\'s workspaces are left alone', () => {
    saveDirectoryWorkspaces([beta], 'https://other.solus.test')
    adopt({ hosts: [], workspaces: [acme] })
    expect(loadWorkspaces().map((workspace) => [workspace.organizationId, workspace.directoryUrl])).toEqual([
      ['org-2', 'https://other.solus.test'],
      ['org-1', DIRECTORY],
    ])
  })

  test('malformed or missing directory facts are rejected instead of guessed', () => {
    expect(directoryResponseSchema.safeParse({ hosts: [machine], workspaces: [{ label: 'no organization' }] }).success).toBe(false)
    for (const field of ['category', 'kind', 'organizationIds']) {
      const invalid = Object.fromEntries(Object.entries(machine).filter(([key]) => key !== field))
      expect(directoryResponseSchema.safeParse({ hosts: [invalid], workspaces: [acme] }).success).toBe(false)
    }
    expect(directoryResponseSchema.safeParse({ hosts: [machine], workspaces: [{ ...acme, policy: { syncAllInsights: 'yes' } }] }).success).toBe(false)
    expect(directoryResponseSchema.safeParse({ hosts: [machine], workspaces: [{ ...acme, policy: undefined }] }).success).toBe(false)
  })

  test('a workspace is dialed on its tunnel alone, with a grant for its own id', () => {
    const [saved] = saveDirectoryWorkspaces([{ ...acme, routes: [{ kind: 'direct', url: 'http://10.0.0.1:1' }, ...acme.routes] }], DIRECTORY)
    expect(workspaceTarget(saved)).toEqual({
      id: 'workspace:org-1',
      label: 'Acme',
      url: 'https://workspace.solus.test',
      sessionToken: '',
      local: false,
      routes: [{ kind: 'tunnel', url: 'https://workspace.solus.test' }],
      uplink: { hostId: 'workspace:org-1', directoryUrl: DIRECTORY, organizationIds: ['org-1'] },
    })
  })

  test('the window\'s choice picks the active workspace; a choice the directory dropped falls back', () => {
    // WHY (organization-scope §2, §7): each window selects one organization, and the
    // account's active mark only seeds a window that has not chosen.
    adopt({ hosts: [], workspaces: [acme, beta] })
    windowOrganizationSelection.set('org-2')
    expect(activeWorkspace(loadWorkspaces())?.organizationId).toBe('org-2')
    adopt({ hosts: [], workspaces: [acme] })
    expect(activeWorkspace(loadWorkspaces())?.organizationId).toBe('org-1')
  })
})
