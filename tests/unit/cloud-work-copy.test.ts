import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Work } from '@solus/contracts/types'

const stateShim = <T>(value?: T) => value
const host: typeof globalThis & { $state?: typeof stateShim } = globalThis
const previous = host.$state
beforeAll(() => { host.$state = stateShim })
afterAll(() => { if (previous) host.$state = previous; else delete host.$state })
const original: Work = { id: 'w', title: 'Draft', content: 'Original', type: 'doc', preview: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', agentProvider: 'claude-code', cwd: '~' }
const newer: Work = { ...original, content: 'Another person’s edit', updatedAt: '2026-01-01T00:00:00.001Z' }

test('an upstream change warns without replacing the copy being read', async () => {
  const { CloudWorkCopy } = await import('@solus/workspace-ui/contexts/works/cloud-work-copy.store.svelte')
  const copy = new CloudWorkCopy(original, { loadWork: async () => newer, loadWorkUpdatedAt: async () => newer.updatedAt })
  await copy.check()
  expect(copy.changed).toBe(true)
  expect(copy.work.content).toBe('Original')
  expect(await copy.reload()).toBe(true)
  expect(copy.work.content).toBe(newer.content)
  expect(copy.changed).toBe(false)
})

test('an own save advances the baseline; a late check cannot report a false change', async () => {
  const { CloudWorkCopy } = await import('@solus/workspace-ui/contexts/works/cloud-work-copy.store.svelte')
  let resolve!: (version: string) => void
  const copy = new CloudWorkCopy(original, { loadWork: async () => newer, loadWorkUpdatedAt: () => new Promise<string>(done => { resolve = done }) })
  const pending = copy.check()
  await copy.save({ content: 'My edit' }, async (_updates, version) => {
    expect(version).toBe(original.updatedAt)
    return { ...newer, content: 'My edit' }
  })
  resolve(original.updatedAt)
  await pending
  expect(copy.changed).toBe(false)
  expect(copy.work.content).toBe('My edit')
})

test('failed checks and reloads retain the open copy; retry detects the change', async () => {
  const { CloudWorkCopy } = await import('@solus/workspace-ui/contexts/works/cloud-work-copy.store.svelte')
  let offline = true
  const copy = new CloudWorkCopy(original, { loadWork: async () => { throw new Error('offline') }, loadWorkUpdatedAt: async () => { if (offline) throw new Error('offline'); return newer.updatedAt } })
  await copy.check()
  expect(copy.error).toContain('Could not check')
  expect(await copy.reload()).toBe(false)
  expect(copy.work.content).toBe(original.content)
  offline = false
  await copy.check()
  expect(copy.changed).toBe(true)
  expect(copy.error).toBeNull()
})

test('a refused stale save keeps the current copy and reports the remote change', async () => {
  const { CloudWorkCopy } = await import('@solus/workspace-ui/contexts/works/cloud-work-copy.store.svelte')
  const copy = new CloudWorkCopy(original, { loadWork: async () => newer, loadWorkUpdatedAt: async () => newer.updatedAt })
  await expect(copy.save({ content: 'Draft' }, async () => { throw new Error('changed') })).rejects.toThrow('changed')
  expect(copy.changed).toBe(true)
  expect(copy.work.content).toBe(original.content)
})
