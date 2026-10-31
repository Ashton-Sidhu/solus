import { expect, test } from 'bun:test'
import config from '../../electron.vite.config'

test.each(['development', 'production'])('bundles every renderer dependency in %s', (mode) => {
  // WHY: the packaged app ships no node_modules for the renderer; an external there is a missing module at runtime.
  const resolved = config({ command: 'build', mode })

  expect(resolved.renderer?.build?.rollupOptions?.external).toBeUndefined()
})
