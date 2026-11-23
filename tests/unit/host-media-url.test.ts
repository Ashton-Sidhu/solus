import { afterAll, expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'

const runes = new SvelteRunes()
afterAll(() => runes.dispose())

const host = runes.module('host', `
  export const serverConnections = {
    capabilitiesFor: async () => ({ assetUrls: true }),
    httpOriginFor: (serverId) => 'https://' + serverId + '.example',
    apiFor: () => ({}),
  }
  export const assetUrlCache = {
    resolve: async ({ origin, path, refresh }) => origin + path + (refresh ? '?fresh' : ''),
  }
`)
const media = runes.source('host-media-url', 'packages/workspace-ui/src/lib/host-media-url.svelte.ts', {
  '@solus/client-core/server-connections': host,
  '../components/artifact/lib/asset-url': host,
})
const fixture = runes.module('fixture', `
  import { flushSync } from 'svelte'
  import { HostMediaUrl } from ${JSON.stringify(media)}

  export function create() {
    const state = $state({ status: 'idle', path: '/project/first.mp4' })
    const urls = []
    const firstLoad = Promise.withResolvers()
    const secondLoad = Promise.withResolvers()
    let media
    const destroy = $effect.root(() => {
      media = new HostMediaUrl(() => state.path ? {
        serverId: 'host',
        path: state.path,
        ctx: { session: { sessionId: 'session', status: state.status } },
      } : null)
      $effect(() => {
        const url = media.url
        urls.push(url)
        if (url?.endsWith('/first.mp4')) firstLoad.resolve(url)
        if (url?.endsWith('/second.mp4')) secondLoad.resolve(url)
      })
    })
    flushSync()
    return { state, urls, firstLoad: firstLoad.promise, secondLoad: secondLoad.promise,
      flush: flushSync, retry: () => media.retry(), destroy }
  }
`)
const { create } = await import(fixture) as {
  create(): {
    state: { status: string; path: string }
    urls: Array<string | null>
    firstLoad: Promise<string>
    secondLoad: Promise<string>
    flush(): void
    retry(): Promise<void>
    destroy(): void
  }
}

test('a turn status change keeps an existing video source attached', async () => {
  const { state, urls, firstLoad, secondLoad, flush, retry, destroy } = create()
  try {
    expect(await firstLoad).toBe('https://host.example/project/first.mp4')
    urls.length = 0

    state.status = 'running'
    flush()
    expect(urls).toEqual([])

    state.path = '/project/second.mp4'
    flush()
    expect(urls).toEqual([null])
    expect(await secondLoad).toBe('https://host.example/project/second.mp4')
    await retry()
    flush()
    expect(urls.at(-1)).toBe('https://host.example/project/second.mp4?fresh')
  } finally {
    destroy()
  }
})
