import { describe, expect, test } from 'bun:test'
import type { SavedServer } from '@solus/client-core/server-registry'
import type { ManagedHostLifecycle } from '@solus/contracts/uplink'
import {
  DIRECTORY_REFRESH_MS,
  DIRECTORY_SETTLING_REFRESH_MS,
  directoryRefreshDelayMs,
} from '../../packages/workspace-ui/src/contexts/connections/directory-refresh'

// Nothing pushes the account's host directory. A managed host that finishes
// starting while the client runs must become pickable soon after it is ready,
// and a host added elsewhere must still be found without a restart.

const directoryUrl = 'https://app.solus.test'

function managedHost(managedState: ManagedHostLifecycle): SavedServer {
  return {
    id: `managed-${managedState}`,
    label: 'Basic',
    url: 'https://solus-h-abc.sprites.app',
    installationId: `install-${managedState}`,
    uplink: { hostId: 'h_abc', directoryUrl, kind: 'managed', managedState },
  } as SavedServer
}

const personalHost = {
  id: 'laptop',
  label: 'Laptop',
  url: 'https://h-laptop.solus.test',
  installationId: 'install-laptop',
  uplink: { hostId: 'h_laptop', directoryUrl, kind: 'personal' },
} as SavedServer

const workspaceService = {
  id: 'workspace:org_1',
  label: 'Acme',
  url: directoryUrl,
  installationId: 'workspace:org_1',
  uplink: { hostId: 'workspace:org_1', directoryUrl, kind: 'cloud' },
} as SavedServer

describe('how often the host directory is read', () => {
  test('a managed host that is provisioning or starting is read for often, so it is pickable soon after ready', () => {
    expect(directoryRefreshDelayMs([personalHost, managedHost('provisioning')])).toBe(DIRECTORY_SETTLING_REFRESH_MS)
    expect(directoryRefreshDelayMs([managedHost('starting')])).toBe(DIRECTORY_SETTLING_REFRESH_MS)
  })

  test('a ready, stopped or failed host does not keep the client reading often', () => {
    // Stopped and failed wait for a person; fast reads would find nothing new.
    for (const state of ['ready', 'stopped', 'failed'] as const) {
      expect(directoryRefreshDelayMs([managedHost(state)])).toBe(DIRECTORY_REFRESH_MS)
    }
  })

  test('with no managed host settling, the slow read still runs, for a host or organization added elsewhere', () => {
    expect(directoryRefreshDelayMs([])).toBe(DIRECTORY_REFRESH_MS)
    expect(directoryRefreshDelayMs([personalHost, workspaceService])).toBe(DIRECTORY_REFRESH_MS)
  })
})
