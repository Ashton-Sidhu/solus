import { afterAll, expect, mock, test } from 'bun:test'

// WHY: Several found machines are added at once, each in the ways that need no
// code and nobody at the machine, because a machine with no screen cannot approve
// a request. An added machine leaves the selection and is saved once; one that
// needs SSH or a code stays selected and says so; a machine that cannot be added
// in one step is never sent anything.

const attempts: Array<{ url: string; installationId?: string; onTailnet?: boolean }> = []
const saved: string[] = []
mock.module('@solus/workspace-ui/components/fleet/add-machine', () => ({
  pairWithoutCode: async (target: { url: string; installationId?: string; onTailnet?: boolean }) => {
    attempts.push(target)
    return target.url.includes('box') ? null : { id: target.url, label: target.url }
  },
}))
mock.module('@solus/workspace-ui/contexts', () => ({
  discoveredServerUrl: (server: { url: string }) => server.url,
  serversStore: { savePairedServer: async (host: { id: string }) => { saved.push(host.id) } },
}))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})
const { AddSeveral } = await import('@solus/workspace-ui/components/fleet/add-several.svelte')

const server = (key: string) => ({ kind: 'server' as const, key, name: key, source: 'lan' as const, detail: '', zone: 'own' as const, server: { url: `http://${key}:7777`, installationId: `id-${key}` } as never })
const ssh = { kind: 'ssh' as const, key: 'devbox', name: 'devbox', source: 'ssh-config' as const, detail: '', zone: 'own' as const, sshTarget: 'devbox' }

test('each selected machine pairs with no code; an added one leaves the selection and one that needs a code stays', async () => {
  const several = new AddSeveral()
  const found = [server('nas'), server('box'), server('laptop'), ssh]
  several.toggleAll(found)
  several.toggle('laptop', false)
  expect([...several.selected].sort()).toEqual(['box', 'nas'])

  await several.add(found)
  expect(attempts.map(({ url, installationId }) => [url, installationId]).sort()).toEqual([['http://box:7777', 'id-box'], ['http://nas:7777', 'id-nas']])
  expect(saved).toEqual(['http://nas:7777'])
  expect(several.outcomes.get('nas')).toEqual({ state: 'added' })
  expect(several.outcomes.get('box')).toEqual({ state: 'failed', message: 'box needs SSH or a pairing code. Choose Connect.' })
  expect([...several.selected]).toEqual(['box'])
  expect(several.isRunning).toBe(false)
})

// WHY: a route is saved as Tailscale only when the pairing says so, because an
// address in 100.64.0.0/10 alone does not prove it (other VPNs share the range).
test('a machine found on the tailnet pairs as a tailnet route; one found on the local network does not', async () => {
  attempts.length = 0
  const several = new AddSeveral()
  const tailnet = { ...server('studio'), source: 'tailnet' as const }
  const found = [server('nas'), tailnet]
  several.toggleAll(found)
  await several.add(found)
  expect(attempts.map(({ url, onTailnet }) => [url, onTailnet]).sort()).toEqual([['http://nas:7777', false], ['http://studio:7777', true]])
})
