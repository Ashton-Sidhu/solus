import { describe, expect, test } from 'bun:test'
import { forgetHostConnections, type HostConnectionOwner } from '@solus/client-core/forget-host'
import type { HostRoute } from '@solus/contracts/host-routes'

function owner(installationId: string, remove: (id: string) => Promise<void>): HostConnectionOwner {
  return { installationId, label: installationId, api: {
    hostListRemove: remove, hostIntroductionsList: async () => ({ hosts: [], refused: [] }),
    hostIntroductionIssue: async () => { throw new Error('unused') }, hostIntroductionAccept: async () => ({ ok: true }),
  } }
}
const route: HostRoute = { kind: 'forwarded', url: 'http://127.0.0.1:50000', viaHostId: 'holder' }

describe('forgetting a host from any client', () => {
  test('removes its record on all connected owners, excluding the target itself', async () => {
    const removed: string[] = []
    await forgetHostConnections('box', [route], [
      owner('holder', async (id) => { removed.push(`holder:${id}`) }),
      owner('other', async (id) => { removed.push(`other:${id}`) }),
      owner('box', async () => { throw new Error('The target must keep its own sessions.') }),
    ])
    expect(removed).toEqual(['holder:box', 'other:box'])
  })
  test('keeps the client pairing when its SSH holder cannot be reached', async () => {
    await expect(forgetHostConnections('box', [route], [])).rejects.toThrow('Connect to the machine')
  })
  test('reports failure before the caller drops its credential, and permits a retry', async () => {
    let fail = true
    const owners = [owner('holder', async () => { if (fail) throw new Error('offline') })]
    await expect(forgetHostConnections('box', [route], owners)).rejects.toThrow('Try again')
    fail = false
    await forgetHostConnections('box', [route], owners)
  })
})
