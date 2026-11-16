import { expect, mock, test } from 'bun:test'

// This test reads the address rule only. The settings import chain also loads a
// database module that Bun does not provide; no database is opened here.
mock.module('node:sqlite', () => ({ DatabaseSync: class {} }))
const { allowsRemoteAddress } = await import('@solus/server/transport/private-network-access')

test('private listener admits loopback, LAN, and tailnet addresses only', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.2', '192.168.1.2', '172.16.0.1', '100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1']) {
    expect(allowsRemoteAddress('private', address)).toBe(true)
  }
  for (const address of ['8.8.8.8', '100.63.255.255', '100.128.0.1', '2600:1700::1', undefined]) {
    expect(allowsRemoteAddress('private', address)).toBe(false)
  }
  expect(allowsRemoteAddress('any', '8.8.8.8')).toBe(true)
  expect(allowsRemoteAddress('off', '127.0.0.1')).toBe(true)
})

test('tunnel traffic arrives from loopback and passes private admission', () => {
  expect(allowsRemoteAddress('private', '::ffff:127.0.0.1')).toBe(true)
})
