import { describe, expect, test } from 'bun:test'
import type { NetworkInterfaceInfo } from 'os'
import { lanAddressesInReachOrder } from '../../packages/server/src/transport/endpoints'

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` }
}

describe('pairing address order', () => {
  test('puts the Wi-Fi or Ethernet address ahead of bridges, tunnels, and VM networks', () => {
    // WHY: a pairing link or share route that names the Thunderbolt Bridge or a
    // VPN tunnel cannot be reached from a phone on the same Wi-Fi.
    const addresses = lanAddressesInReachOrder({
      lo0: [ipv4('127.0.0.1', true)],
      bridge0: [ipv4('192.168.2.1')],
      utun4: [ipv4('10.8.0.2')],
      awdl0: [ipv4('169.254.10.1')],
      vmnet8: [ipv4('172.16.5.1')],
      docker0: [ipv4('172.17.0.1')],
      en0: [ipv4('192.168.1.20')],
      en1: [ipv4('192.168.1.21')],
    })
    expect(addresses.map(({ address }) => address)).toEqual([
      '192.168.1.20',
      '192.168.1.21',
      '192.168.2.1',
      '10.8.0.2',
      '169.254.10.1',
      '172.16.5.1',
      '172.17.0.1',
    ])
  })

  test('keeps a host bridge that carries the LAN address in the first group', () => {
    // WHY: on Linux hosts `br0` or `vmbr0` often holds the real LAN address.
    const addresses = lanAddressesInReachOrder({
      wg0: [ipv4('10.0.0.2')],
      vmbr0: [ipv4('192.168.1.30')],
      br0: [ipv4('192.168.1.31')],
    })
    expect(addresses.map(({ name }) => name)).toEqual(['vmbr0', 'br0', 'wg0'])
  })

  test('still names a host-only address when no other interface has one', () => {
    // WHY: a machine with only a tunnel must still give a pairing link.
    expect(lanAddressesInReachOrder({ utun2: [ipv4('100.64.0.5')] })).toEqual([{ name: 'utun2', address: '100.64.0.5' }])
  })
})
