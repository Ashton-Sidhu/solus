import { expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Exercise the production loader without importing the full Svelte transcript graph.
const source = readFileSync(new URL('../../packages/workspace-ui/src/components/conversation/lib/conversation-view-loader.ts', import.meta.url), 'utf8')
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source
  .replace(/^type ConversationModule = .*\n/, '')
  .replace('export function loadConversationView', 'function loadConversationView')
  .replace("import('../ConversationView.svelte')", 'importConversation()'))

interface FixtureModule { default: { name: string } }
function loader(importConversation: () => Promise<FixtureModule>): () => FixtureModule | Promise<FixtureModule> {
  return new Function('importConversation', `${compiled}\nreturn loadConversationView;`)(importConversation)
}

test('an empty workspace imports no transcript code; visible conversations share one load', async () => {
  const module = { default: { name: 'conversation' } }
  const pending = Promise.withResolvers<FixtureModule>()
  const importConversation = mock(() => pending.promise)
  const load = loader(importConversation)
  expect(importConversation).not.toHaveBeenCalled()
  const first = load()
  expect(load()).toBe(first)
  expect(importConversation).toHaveBeenCalledTimes(1)
  pending.resolve(module)
  expect(await first).toBe(module)
})

test('restoring an evicted tab returns the loaded component synchronously, without a loading frame', async () => {
  const module = { default: { name: 'conversation' } }
  const importConversation = mock(async () => module)
  const load = loader(importConversation)
  await load()
  expect(load()).toBe(module)
  expect(importConversation).toHaveBeenCalledTimes(1)
})

test('a failed chunk load can be retried instead of leaving the conversation stuck', async () => {
  const module = { default: { name: 'conversation' } }
  const importConversation = mock(async () => {
    if (importConversation.mock.calls.length === 1) throw new Error('Chunk unavailable')
    return module
  })
  const load = loader(importConversation)
  await expect(load()).rejects.toThrow('Chunk unavailable')
  expect(await load()).toBe(module)
})
