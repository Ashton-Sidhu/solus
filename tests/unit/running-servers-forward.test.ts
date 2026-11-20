import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { serverForwardRequestSchema } from '../../apps/desktop/src/main/server-forwards'

test('Node forwards an API path and WebSocket traffic, renews the port, and revokes access', async () => {
  // Bun's ws shim has no createWebSocketStream. Exercise the production Node transport.
  const { stderr } = await promisify(execFile)('node', ['--import', 'tsx', fileURLToPath(new URL('./helpers/running-server-forward.mts', import.meta.url))], { timeout: 10_000 })
  expect(stderr).toBe('')
}, 15_000)

test('native forwarding accepts only scoped tunnel capabilities, never arbitrary proxy URLs', () => {
  const base = { endpointKey: 'host:api', targetUrl: 'http://localhost:3000/admin', expiresAt: Date.now() + 10000 }
  expect(serverForwardRequestSchema.safeParse({ ...base, tunnelUrl: 'ws://example.com/admin' }).success).toBe(false)
  expect(serverForwardRequestSchema.safeParse({ ...base, tunnelUrl: `ws://example.com/api/running-servers/tunnel/${'a'.repeat(43)}` }).success).toBe(true)
})

test('Node resolves checkout subfolders and nested repositories and reads project URLs from the root', async () => {
  await promisify(execFile)('node', ['--import', 'tsx', fileURLToPath(new URL('./helpers/running-server-checkouts.mts', import.meta.url))], { timeout: 10_000 })
}, 15_000)
