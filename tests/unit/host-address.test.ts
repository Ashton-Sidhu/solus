import { describe, expect, test } from 'bun:test'
import { sameNameHostAddresses } from '@solus/client-core/host-address'

describe('sameNameHostAddresses', () => {
  test('two hosts with one name each get the address that tells them apart', () => {
    const addresses = sameNameHostAddresses([
      { id: 'a', label: 'Mac mini', url: 'http://192.168.1.20:4317' },
      { id: 'b', label: 'Mac mini', url: 'https://relay.solus.dev/h/b/' },
      { id: 'c', label: 'Studio', url: 'http://192.168.1.30:4317' },
    ])
    expect(addresses.get('a')).toBe('192.168.1.20:4317')
    expect(addresses.get('b')).toBe('relay.solus.dev/h/b')
  })

  test('a host whose name no other host carries gets no address', () => {
    const addresses = sameNameHostAddresses([
      { id: 'a', label: 'Mac mini', url: 'http://192.168.1.20:4317' },
      { id: 'c', label: 'Studio', url: 'http://192.168.1.30:4317' },
    ])
    expect(addresses.size).toBe(0)
  })
})
