import { describe, expect, test } from 'bun:test'
import {
  turnHostChoices,
  turnHostLabel,
  turnHostServerId,
  turnHostValue,
} from '@solus/workspace-ui/components/insights/lib/turn-hosts'

// docs/plans/insights-across-hosts.md: a pulled turn names its host by the
// workspace service's id. The person knows the host by the name they gave it,
// so the column and the filter use that name where this client has it.

const hosts = [
  { id: 'local', label: 'Studio Mac' },
  { id: 'remote-1', label: 'Build box', uplink: { hostId: 'cloud-host-1' } },
]

describe('host labels', () => {
  test('a turn the host being read ran is named after that host', () => {
    expect(turnHostLabel({ hostId: null, hostname: 'studio.local' }, hosts, 'local')).toBe('Studio Mac')
  })

  test('a pulled turn uses the directory name, then the recorded machine name, then a short id', () => {
    expect(turnHostLabel({ hostId: 'cloud-host-1', hostname: 'buildbox.lan' }, hosts, 'local')).toBe('Build box')
    expect(turnHostLabel({ hostId: 'cloud-host-2', hostname: 'laptop.lan' }, hosts, 'local')).toBe('laptop.lan')
    expect(turnHostLabel({ hostId: 'cloud-host-2', hostname: null }, hosts, 'local')).not.toBe('')
  })

  test('a pulled turn reaches its session only through a host this client knows', () => {
    expect(turnHostServerId('cloud-host-1', hosts)).toBe('remote-1')
    expect(turnHostServerId('cloud-host-2', hosts)).toBeNull()
  })
})

describe('host filter choices', () => {
  test('every host comes first, and each choice maps back to the filter it sets', () => {
    // WHY: "this host" is null and "every host" is absent; mixing them up
    // would show one host's turns while the menu says all.
    const choices = turnHostChoices(
      [{ hostId: 'cloud-host-1', hostname: null, count: 3 }, { hostId: null, hostname: 'studio.local', count: 1 }],
      (host) => turnHostLabel(host, hosts, 'local'),
    )
    expect(choices.map((choice) => [choice.label, choice.hostId, choice.count])).toEqual([
      ['All hosts', undefined, null],
      ['Build box', 'cloud-host-1', 3],
      ['Studio Mac', null, 1],
    ])
    for (const choice of choices) expect(turnHostValue(choice.hostId)).toBe(choice.value)
  })
})
