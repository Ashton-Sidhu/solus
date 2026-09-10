import { expect, test } from 'bun:test'
import { INTERNAL_HANDLER_CTX, SolusServer } from '@solus/server/server/server'

test('trial startup rejects RPC mutations before invoking their handlers and reopens after commit', async () => {
  const server = new SolusServer()
  let writes = 0
  server.register('setProjectsBaseDirectory', async () => { writes++; return { projectsBaseDirectory: '/tmp/projects' } })
  server.setUpdateTrial(true)
  await expect(server.handle('setProjectsBaseDirectory', ['/tmp/projects'], INTERNAL_HANDLER_CTX)).rejects.toThrow('verifying an update')
  expect(writes).toBe(0)
  server.setUpdateTrial(false)
  await server.handle('setProjectsBaseDirectory', ['/tmp/projects'], INTERNAL_HANDLER_CTX)
  expect(writes).toBe(1)
})
