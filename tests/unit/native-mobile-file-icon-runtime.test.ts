import { expect, test } from 'bun:test'

test('native file icons load without the browser custom element runtime', async () => {
  expect(typeof globalThis.customElements).toBe('undefined')
  const { createFileTreeIconResolver, getBuiltInSpriteSheet } = await import('../../apps/mobile/pierre-tree-icons.js')
  const resolver = createFileTreeIconResolver({ set: 'complete', colored: true })
  expect(resolver.resolveIcon('file-tree-icon-file', 'App.tsx').name).toBe('file-tree-builtin-react')
  expect(getBuiltInSpriteSheet('complete')).toContain('file-tree-builtin-react')
})
