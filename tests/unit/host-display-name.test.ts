import { describe, expect, test } from 'bun:test'
import { resolveHostDisplayName } from '@solus/server/platform/host-display-name'

interface ProbeOptions {
  platform: NodeJS.Platform
  hostname: string
  machineInfo?: string | null
  commandOutputs?: Map<string, string | null>
}

function probe(options: ProbeOptions): Parameters<typeof resolveHostDisplayName>[0] {
  return {
    platform: options.platform,
    hostname: options.hostname,
    readFile: (path) => path === '/etc/machine-info' ? (options.machineInfo ?? null) : null,
    run: (command, args) => options.commandOutputs?.get(`${command} ${args.join(' ')}`) ?? null,
  }
}

describe('host display name', () => {
  test('uses the macOS ComputerName instead of the network hostname', () => {
    expect(resolveHostDisplayName(probe({
      platform: 'darwin',
      hostname: 'Ashtons-mac-mini.local',
      commandOutputs: new Map([
        ['/usr/sbin/scutil --get ComputerName', "Ashton's Mac mini\n"],
      ]),
    }))).toBe("Ashton's Mac mini")
  })

  test('uses PRETTY_HOSTNAME on Linux', () => {
    expect(resolveHostDisplayName(probe({
      platform: 'linux',
      hostname: 'build-agent-01',
      machineInfo: 'PRETTY_HOSTNAME="Build Agent 01"\n',
    }))).toBe('Build Agent 01')
  })

  test('uses hostnamectl when machine-info has no friendly name', () => {
    expect(resolveHostDisplayName(probe({
      platform: 'linux',
      hostname: 'build-agent-01',
      machineInfo: 'ICON_NAME=computer-vm\n',
      commandOutputs: new Map([
        ['hostnamectl --pretty', 'CI Runner\n'],
      ]),
    }))).toBe('CI Runner')
  })

  test('falls back to the network hostname', () => {
    expect(resolveHostDisplayName(probe({
      platform: 'win32',
      hostname: 'WORKSTATION-01',
    }))).toBe('WORKSTATION-01')
  })
})
