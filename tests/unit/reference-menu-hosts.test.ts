import { describe, expect, test } from 'bun:test'
import { fleetMachine, type FleetMachineInput } from '@solus/workspace-ui/components/fleet/lib/fleet-model'
import { KINDS, kindForSlug } from '@solus/workspace-ui/components/editor/unified-autocomplete/kinds'
import { hostMenuItem } from '@solus/workspace-ui/components/editor/unified-autocomplete/reference-index.svelte'
import { findAnchor, readTrigger } from '@solus/workspace-ui/components/editor/unified-autocomplete/trigger'
import { serializeReferenceToken } from '@solus/workspace-ui/components/editor/reference-tokens'

// WHY: A person names a host in a prompt from the
// `#` menu, as they name a task or a session. A host that the menu does not
// list, or a row that inserts a link no client can open, makes the host chip a
// thing only "Ask an agent" can write.

const studio: FleetMachineInput = {
  serverId: 'h1',
  installationId: 'install-1',
  label: 'studio-mini',
  os: 'linux',
  isThisDevice: false,
  isCloud: false,
  hasManagedCompute: false,
  principal: 'local-owner',
  readiness: 'unreachable',
  routeKind: 'tailnet',
  address: 'http://100.88.12.4:4317',
  sessions: 0,
  load: null,
  hasUpdate: false,
  needsSetup: false,
}

describe('hosts in the # menu', () => {
  test('Hosts is a category a person drills into with #hosts/', () => {
    expect(KINDS.map((kind) => kind.key)).toContain('host')
    expect(kindForSlug('hosts')?.key).toBe('host')
    expect(readTrigger('ask #hosts/stu', findAnchor('ask #hosts/stu'))).toMatchObject({ char: '#', path: ['host'], query: 'stu' })
  })

  test('a host row says how the host is reached and whether it answers, and inserts its chip', () => {
    const row = hostMenuItem(fleetMachine(studio))
    expect(row).toMatchObject({ id: 'host:h1', title: 'studio-mini', meta: 'Tailscale · unreachable', refKind: 'host' })
    expect(serializeReferenceToken(row.token)).toBe(
      '[studio-mini](host://ref?serverId=install-1&route=Tailscale&system=linux&address=http%3A%2F%2F100.88.12.4%3A4317&state=unreachable)',
    )
  })
})
