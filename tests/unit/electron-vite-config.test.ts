import { expect, test } from 'bun:test'
import config from '../../electron.vite.config'
import packageJson from '../../package.json'

test.each(['development', 'production'])('keeps the Node Socket.IO client external in %s', (mode) => {
  const resolved = config({ command: 'build', mode })

  expect(resolved.main?.build?.rollupOptions?.external).toContain('socket.io-client')
  expect(resolved.renderer?.build?.rollupOptions?.external).toBeUndefined()
})

test('ships the external Socket.IO client as a runtime dependency', () => {
  expect(packageJson.dependencies['socket.io-client']).toBeDefined()
})
