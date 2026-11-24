import { expect, test } from 'bun:test'
import { scopedNewCheckout } from '@solus/workspace-ui/components/session/lib/scoped-new'

const scope = { key: 'repo', label: 'Repo', projectKey: '/local/repo', serverId: 'local', available: true }
const checkouts = [
  { serverId: 'local', projectRoot: '/local/repo' },
  { serverId: 'remote', projectRoot: '/remote/repo' },
]

test('starts in the viewed host when it has a checkout of the scoped project', () => {
  expect(scopedNewCheckout(scope, checkouts, 'remote', () => true)).toEqual(checkouts[1]!)
  expect(scopedNewCheckout(scope, checkouts, 'another-host', () => true)).toEqual(checkouts[0]!)
})

test('chooses a permitted checkout or leaves the scoped action unavailable', () => {
  expect(scopedNewCheckout(scope, checkouts, 'remote', (host) => host === 'local')).toEqual(checkouts[0]!)
  expect(scopedNewCheckout(scope, checkouts, 'remote', () => false)).toBeUndefined()
  expect(scopedNewCheckout({ ...scope, available: false }, [], undefined, () => true)).toBeUndefined()
})
