import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { derived, get } from 'svelte/internal/client'
import type { SkillListResult } from '@solus/contracts/skill-types'
import type { RemoteSkill } from '@solus/contracts/types'

const previousState = Object.getOwnPropertyDescriptor(globalThis, '$state')
let SkillsStore: typeof import('@solus/workspace-ui/components/settings/skills.store.svelte')['SkillsStore']
let SkillSearch: typeof import('@solus/workspace-ui/components/settings/skills.store.svelte')['SkillSearch']
let skillsForHost: typeof import('@solus/workspace-ui/components/settings/skills.store.svelte')['skillsForHost']
let ListWindow: typeof import('@solus/workspace-ui/components/settings/skills.store.svelte')['ListWindow']
beforeAll(async () => {
  Object.defineProperty(globalThis, '$state', { configurable: true, value: <T>(value: T) => value })
  ;({ SkillsStore, SkillSearch, skillsForHost, ListWindow } = await import('@solus/workspace-ui/components/settings/skills.store.svelte'))
})
afterAll(() => {
  if (previousState) Object.defineProperty(globalThis, '$state', previousState)
  else Reflect.deleteProperty(globalThis, '$state')
})
const skill: RemoteSkill = { id: 'owner/skills@design', name: 'design', repo: 'owner/skills', url: 'https://skills.sh/owner/skills/design' }
function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Skills settings state', () => {
  // Run with --conditions=browser to exercise SvelteMap's client mutation guard.
  test('derived host lookups share an inventory without mutating reactive state', () => {
    const inventory = get(derived(() => skillsForHost('skills-host-a')))
    expect(get(derived(() => skillsForHost('skills-host-a')))).toBe(inventory)
    expect(get(derived(() => skillsForHost('skills-host-b')))).not.toBe(inventory)
  })
  test('an older inventory response cannot overwrite a refreshed list', async () => {
    const store = new SkillsStore()
    const old = pending<SkillListResult>()
    const first = store.load({ skillsList: () => old.promise })
    await store.load({ skillsList: async () => ({ ok: true, skills: [] }) })
    old.resolve({ ok: true, skills: [{ name: 'old', agents: [], source: null, path: '/old' }] })
    await first
    expect(store.skills).toEqual([])
    expect(store.loading).toBe(false)
  })
  test('a failed refresh retains the inventory and displays an error', async () => {
    const store = new SkillsStore()
    store.skills = [{ name: 'design', path: '/design', source: skill.repo, agents: ['Codex'] }]
    await store.load({ skillsList: async () => ({ ok: false, error: 'Offline' }) })
    expect(store.error).toBe('Offline')
    expect(store.skills).toHaveLength(1)
  })
  test('global status matches the source as well as the name', () => {
    const store = new SkillsStore()
    store.skills = [{ name: 'design', path: '/design', source: 'other/skills', agents: ['Claude Code'] }]
    expect(store.isInstalled(skill)).toBe(false)
  })
  test('installation feedback works on older hosts without global management', async () => {
    const store = new SkillsStore()
    expect(await store.install({
      skillsInstall: async () => ({ ok: true, agents: ['codex'] }),
      skillsList: async () => { throw new Error('Unsupported') },
    }, skill, false)).toBe(true)
    expect(store.isInstalled(skill)).toBe(true)
    expect(store.message).toBe('design installed globally.')
    expect(store.busy).toBeNull()
  })
  test('external removal clears a previous installation status on refresh', async () => {
    const store = new SkillsStore()
    const api = { skillsInstall: async () => ({ ok: true, agents: [] }), skillsList: async (): Promise<SkillListResult> => ({ ok: true, skills: [] }) }
    await store.install(api, skill, false)
    await store.load(api)
    expect(store.isInstalled(skill)).toBe(false)
  })
  test('changing the search query rejects the old response immediately', async () => {
    const search = new SkillSearch()
    const old = pending<RemoteSkill[]>()
    const first = search.search({ skillsSearch: () => old.promise }, 'design')
    search.cancel()
    old.resolve([skill])
    await first
    expect(search.results).toEqual([])
    expect(search.hasSearched).toBe(false)
    expect(search.searching).toBe(false)
  })
  test('a failed search stops loading and reports an inline error', async () => {
    const search = new SkillSearch()
    await search.search({ skillsSearch: async () => { throw new Error('Offline') } }, 'design')
    expect(search.error).toContain('Could not search')
    expect(search.searching).toBe(false)
  })
  test('a long list mounts one page at a time and grows by one page on request', () => {
    const window = new ListWindow()
    const items = Array.from({ length: ListWindow.PAGE * 2 + 3 }, (_, i) => i)
    expect(window.slice(items)).toHaveLength(ListWindow.PAGE)
    expect(window.remaining(items.length)).toBe(ListWindow.PAGE + 3)
    window.showMore()
    expect(window.slice(items)).toHaveLength(ListWindow.PAGE * 2)
    window.showMore()
    expect(window.slice(items)).toBe(items) // fully shown: no copy, no "show more" row
    expect(window.remaining(items.length)).toBe(0)
  })
})
