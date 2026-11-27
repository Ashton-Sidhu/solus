import { describe, expect, test } from 'bun:test'
import type { AppIcon } from '@solus/contracts/apps'
import { AppIconsStore, svgImageUrl } from '@solus/workspace-ui/contexts/apps/app-icons.store.svelte'

// The icons of the apps on desktop and web (docs/app-shortcuts.md §4). What
// matters: each icon is read once for each hash, so a list of apps costs no
// read until an icon changes; an app with no icon, an icon on its way, and a
// read that failed all give null, so the tile shows the monogram; and a new
// icon does not flash the monogram while it loads.

const ONE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'
const TWO = ONE.replace('<rect', '<circle r="1"/><rect')

function storeWith(icons: { [hash: string]: string }) {
  const reads: string[] = []
  let current = 'one'
  const store = new AppIconsStore(async (_serverId, appId): Promise<AppIcon | null> => {
    reads.push(appId)
    const svg = icons[current]
    if (svg === undefined) throw new Error('The host is gone.')
    return { hash: current, svg }
  })
  return { store, reads, setCurrent: (hash: string) => { current = hash } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the app icons store', () => {
  test('an app with no icon hash reads nothing and shows its monogram', () => {
    const { store, reads } = storeWith({})
    expect(store.urlFor('server', { id: 'notes', iconHash: null })).toBeNull()
    expect(reads).toEqual([])
  })

  test('an icon is read once for its hash, and then is the image address of its SVG', async () => {
    const { store, reads } = storeWith({ one: ONE })
    const app = { id: 'notes', iconHash: 'one' }
    expect(store.urlFor('server', app)).toBeNull()
    expect(store.urlFor('server', app)).toBeNull()
    await settle()
    expect(store.urlFor('server', app)).toBe(svgImageUrl(ONE))
    expect(await store.svgFor('server', app)).toBe(ONE)
    expect(reads).toEqual(['notes'])
  })

  // WHY: a deploy with a new icon must reach the tile; until it arrives, the old icon stays, not the letter.
  test('a new hash reads the icon again and keeps the old one on screen until it arrives', async () => {
    const { store, reads, setCurrent } = storeWith({ one: ONE, two: TWO })
    store.urlFor('server', { id: 'notes', iconHash: 'one' })
    await settle()
    setCurrent('two')
    expect(store.urlFor('server', { id: 'notes', iconHash: 'two' })).toBe(svgImageUrl(ONE))
    await settle()
    expect(store.urlFor('server', { id: 'notes', iconHash: 'two' })).toBe(svgImageUrl(TWO))
    expect(reads).toHaveLength(2)
  })

  test('a read that fails gives null, so the tile shows the monogram', async () => {
    const { store } = storeWith({})
    expect(await store.svgFor('server', { id: 'notes', iconHash: 'one' })).toBeNull()
    expect(store.urlFor('server', { id: 'notes', iconHash: 'one' })).toBeNull()
  })

  test('the image address holds the SVG as it is', () => {
    expect(decodeURIComponent(svgImageUrl(ONE).replace('data:image/svg+xml;charset=utf-8,', ''))).toBe(ONE)
  })
})
