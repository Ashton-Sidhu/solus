import { afterAll, expect, mock, test } from 'bun:test'

// WHY: a drop on a found machine on the host map, and the Approve tab of the Add
// host dialog, share one approval request. The code the person compares must show
// while it waits and go when it ends; Stop must end it without calling it a
// failure; a new request must end the one before it; and a machine found on
// Tailscale must pair as a Tailscale route. A machine that has no approval
// requests (an older Solus) must not read as a failure that Ask again could fix.

type Pairing = { url: string; checkCode: string; signal: AbortSignal; onTailnet: boolean; resolve: () => void; reject: (error: Error) => void }
const pairings: Pairing[] = []
class ApprovalUnavailableError extends Error {}
mock.module('@solus/workspace-ui/components/fleet/add-machine', () => ({
  ApprovalUnavailableError,
  pairWithApproval: (url: string, checkCode: string, _onWaiting: unknown, signal: AbortSignal, onTailnet = false) =>
    new Promise<void>((resolve, reject) => {
      pairings.push({ url, checkCode, signal, onTailnet, resolve, reject })
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
}))
mock.module('@solus/workspace-ui/contexts', () => ({ discoveredServerUrl: (server: { host: string; port: number }) => `http://${server.host}:${server.port}` }))
mock.module('@solus/workspace-ui/components/servers/lib/setup-rpc', () => ({ messageFor: (error: Error) => error.message }))
mock.module('@solus/workspace-ui/lib/check-code', () => ({ newCheckCode: () => '29GP-W5CK' }))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})
const { approvalRequestStore: store } = await import('@solus/workspace-ui/components/servers/approval-request.store.svelte')

const found = (name: string, source: 'lan' | 'tailnet') => ({
  kind: 'server' as const, key: `server:${name}`, name, source, detail: '', zone: 'own' as const,
  server: { host: name, port: 3000, name, installationId: name, source } as never,
})

test('the code shows while the request waits, and goes when it is approved', async () => {
  const done = store.start(found('sidhu', 'lan'))
  expect([store.phase, store.checkCode, pairings.at(-1)?.onTailnet]).toEqual(['waiting', '29GP-W5CK', false])
  pairings.at(-1)!.resolve()
  await done
  expect([store.phase, store.checkCode]).toEqual(['added', null])
})

test('a machine found on Tailscale pairs as a Tailscale route', async () => {
  const done = store.start(found('pi', 'tailnet'))
  expect(pairings.at(-1)).toMatchObject({ url: 'http://pi:3000', onTailnet: true })
  pairings.at(-1)!.resolve()
  await done
})

test('Stop ends the request without a failure, and keeps the machine for Ask again', async () => {
  const done = store.start(found('sidhu', 'lan'))
  store.stop()
  await done
  expect([store.phase, store.message, store.checkCode, store.machine?.name]).toEqual(['idle', null, null, 'sidhu'])
})

test('a denied request says why', async () => {
  const done = store.start(found('sidhu', 'lan'))
  pairings.at(-1)!.reject(new Error('The owner of that machine denied the request.'))
  await done
  expect([store.phase, store.message]).toEqual(['failed', 'The owner of that machine denied the request.'])
})

test('a new request ends the one before it, and the old one cannot change what shows', async () => {
  const first = store.start(found('sidhu', 'lan'))
  const firstPairing = pairings.at(-1)!
  const second = store.start(found('pi', 'tailnet'))
  await first
  expect(firstPairing.signal.aborted).toBe(true)
  expect([store.machine?.name, store.phase, store.checkCode]).toEqual(['pi', 'waiting', '29GP-W5CK'])
  pairings.at(-1)!.resolve()
  await second
  expect(store.phase).toBe('added')
  store.clear()
  expect([store.machine, store.phase]).toEqual([null, 'idle'])
})

test('a machine with no approval requests says to use a pairing code, not to ask again', async () => {
  const done = store.start(found('sidhu', 'lan'))
  pairings.at(-1)!.reject(new ApprovalUnavailableError())
  await done
  expect([store.phase, store.message]).toEqual(['unavailable', 'sidhu runs an older Solus. Use a pairing code.'])
})
