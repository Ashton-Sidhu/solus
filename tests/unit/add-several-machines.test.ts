import { afterAll, expect, mock, test } from 'bun:test'

// WHY: Several found machines are added at once: each
// gets its own approval request, all with one check code the person compares on each
// machine. An added machine leaves the selection; a failed one stays, so Add tries
// it again; a machine that cannot be added in one step is never sent a request.

const requests: Array<{ url: string; checkCode: string; onTailnet: boolean }> = []
mock.module('@solus/workspace-ui/components/fleet/add-machine', () => ({
  pairWithApproval: async (url: string, checkCode: string, _onWaiting: unknown, _signal: unknown, onTailnet = false) => {
    requests.push({ url, checkCode, onTailnet })
    if (url.includes('box')) throw new Error('The owner of that machine denied the request.')
    return { id: url, label: url }
  },
}))
mock.module('@solus/workspace-ui/contexts', () => ({ discoveredServerUrl: (server: { url: string }) => server.url }))
mock.module('@solus/workspace-ui/components/servers/lib/setup-rpc', () => ({ messageFor: (error: Error) => error.message }))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})
const { AddSeveral } = await import('@solus/workspace-ui/components/fleet/add-several.svelte')

const server = (key: string) => ({ kind: 'server' as const, key, name: key, source: 'lan' as const, detail: '', zone: 'own' as const, server: { url: `http://${key}:7777` } as never })
const ssh = { kind: 'ssh' as const, key: 'devbox', name: 'devbox', source: 'ssh-config' as const, detail: '', zone: 'own' as const, sshTarget: 'devbox' }

test('one check code reaches each selected machine; an added one leaves the selection and a failed one stays', async () => {
  const several = new AddSeveral()
  const found = [server('nas'), server('box'), server('laptop'), ssh]
  several.toggleAll(found)
  several.toggle('laptop', false)
  expect([...several.selected].sort()).toEqual(['box', 'nas'])

  await several.add(found)
  expect(requests.map(({ url }) => url).sort()).toEqual(['http://box:7777', 'http://nas:7777'])
  expect(new Set(requests.map(({ checkCode }) => checkCode)).size).toBe(1)
  expect(several.outcomes.get('nas')).toEqual({ state: 'added' })
  expect(several.outcomes.get('box')).toEqual({ state: 'failed', message: 'The owner of that machine denied the request.' })
  expect([...several.selected]).toEqual(['box'])
  expect(several.isRunning).toBe(false)
  expect(several.checkCode).toBeNull()
})

// WHY: a route is saved as Tailscale only when the pairing says so, because an
// address in 100.64.0.0/10 alone does not prove it (other VPNs share the range).
// A machine the scan found on the tailnet must say so when it pairs by approval,
// as it does with a code; otherwise its route is saved under the wrong kind and is
// not counted as encrypted.
test('a machine found on the tailnet pairs as a tailnet route; one found on the local network does not', async () => {
  requests.length = 0
  const several = new AddSeveral()
  const tailnet = { ...server('studio'), source: 'tailnet' as const }
  const found = [server('nas'), tailnet]
  several.toggleAll(found)
  await several.add(found)
  expect(requests.map(({ url, onTailnet }) => [url, onTailnet]).sort()).toEqual([['http://nas:7777', false], ['http://studio:7777', true]])
})
