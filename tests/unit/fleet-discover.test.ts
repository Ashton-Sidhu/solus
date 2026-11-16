import { describe, expect, test } from 'bun:test'
import { foundMachines } from '@solus/workspace-ui/components/fleet/lib/discover'

// WHY: docs/plans/host-fleet.md D7. Discover lists what this device can see but has
// not added, from four sources, each with the one action that adds it. A machine
// already added must not show up again as "found", or the person adds it twice.

const imac = { host: '192.168.1.42', port: 4317, name: "Mia's iMac", installationId: 'i-imac', os: 'macos' as const, source: 'lan' as const }
const nas = { host: '100.88.12.4', port: 4317, name: 'nas-01', installationId: 'i-nas', source: 'tailnet' as const }

describe('found machines', () => {
  test('each source gives its own kind, source, and zone', () => {
    const found = foundMachines({
      nearby: [imac, nas],
      wsl: { windowsHostId: 'pc', windowsHostName: 'gaming-pc', distros: [{ name: 'Debian', isDefault: false, isRunning: false, version: 2 }] },
      sshConfig: [{ target: 'ada@devbox', label: 'devbox -> devbox.internal', source: 'ssh-config' }],
      knownNames: new Set(),
    })
    expect(found.map((machine) => [machine.kind, machine.source, machine.zone, machine.name])).toEqual([
      ['server', 'lan', 'own', "Mia's iMac"],
      ['server', 'tailnet', 'own', 'nas-01'],
      ['wsl', 'wsl', 'own', 'Debian'],
      ['ssh', 'ssh-config', 'own', 'devbox'],
    ])
    expect(found[0]).toMatchObject({ os: 'macos', detail: '192.168.1.42:4317' })
    expect(found[2]).toMatchObject({ os: 'linux', detail: 'On gaming-pc' })
  })

  test('an SSH config machine already added, by its alias, its address, or its target, is not found again', () => {
    const sshConfig = [{ target: 'ada@devbox', label: 'devbox -> devbox.internal', source: 'ssh-config' as const }]
    for (const name of ['devbox', 'DEVBOX.internal', 'ada@devbox']) {
      expect(foundMachines({ nearby: [], wsl: null, sshConfig, knownNames: new Set([name]) })).toEqual([])
    }
  })
})
