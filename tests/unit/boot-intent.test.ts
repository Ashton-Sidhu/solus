import { describe, expect, test } from 'bun:test'
import { serializeRoute } from '@solus/workspace-ui/contexts/workspace/routing/codec'
import { addressedBootIntent } from '../../apps/client/src/lib/boot-intent'

// docs/plans/instant-share-open.md: a page that opens at an address naming a server
// dials that server before every other, and before the directory answers. Only a
// resource in the leading pane (a member link) skips the last tab's transcript and the
// account cover; a surface opens beside the conversation, which still needs them.

describe('the intent of the page address', () => {
  test('a member link opens a resource on the server it names', () => {
    const address = serializeRoute({ name: 'sessionRecord', params: { sessionId: 'sess1', serverId: 'managed:26ipon2agai6hagk' } })
    expect(addressedBootIntent(address)).toEqual({ firstServerId: 'managed:26ipon2agai6hagk', opensResource: true })
  })

  test('a surface names its server but leaves the conversation as it was', () => {
    const address = serializeRoute({ name: 'files', params: { serverId: 'host-a', cwd: '/repo' } })
    expect(addressedBootIntent(address)?.firstServerId).toBe('host-a')
  })

  test('an address that names no server, or no route, has no intent', () => {
    expect(addressedBootIntent('/')).toBeUndefined()
    expect(addressedBootIntent('/not-a-route')).toBeUndefined()
    expect(addressedBootIntent(serializeRoute({ name: 'chat', params: {} }))).toBeUndefined()
  })
})
