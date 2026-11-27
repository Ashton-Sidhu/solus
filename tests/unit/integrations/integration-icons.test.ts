import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Icon } from '@modelcontextprotocol/client'
import { DatabaseSync } from '../helpers/bun-sqlite'
import { resetTestDatabase } from '../helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// A server's own icon (MCP `serverInfo.icons`) is what its tile shows first.
// The host fetches it once and gives clients a `data:` URI, so a client never
// fetches an address a server chose, and a bad answer never becomes an icon.

const dataDir = mkdtempSync(join(tmpdir(), 'solus-integration-icons-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
let icons: typeof import('@solus/server/integrations/integration-icons')

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  icons = await import('@solus/server/integrations/integration-icons')
})

afterAll(async () => {
  await resetTestDatabase()
  process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

/** A fetch that answers each address from the table, and counts the calls. */
function fakeFetch(answers: Record<string, () => Response>) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const answer = answers[url]
    if (!answer) throw new Error(`no answer for ${url}`)
    return answer()
  }) as typeof fetch
  return { calls, fetchImpl }
}

const png = () => new Response(PNG, { headers: { 'content-type': 'image/png' } })

describe('chooseIcons', () => {
  test('a scalable icon wins over a large one, and a dark icon is kept apart', () => {
    const chosen = icons.chooseIcons([
      { src: 'https://x.example/32.png', sizes: ['32x32'] },
      { src: 'https://x.example/logo.svg', mimeType: 'image/svg+xml' },
      { src: 'https://x.example/dark.png', theme: 'dark', sizes: ['64x64'] },
    ])
    expect(chosen.light?.src).toBe('https://x.example/logo.svg')
    expect(chosen.dark?.src).toBe('https://x.example/dark.png')
  })

  test('an http: or file address is never a candidate', () => {
    expect(icons.chooseIcons([{ src: 'http://x.example/a.png' }, { src: 'file:///etc/passwd' }])).toEqual({ light: null, dark: null })
  })
})

describe('iconDataUri', () => {
  test('a small image becomes a data URI', async () => {
    const { fetchImpl } = fakeFetch({ 'https://x.example/a.png': png })
    expect(await icons.iconDataUri({ src: 'https://x.example/a.png' }, fetchImpl)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
  })

  test('an answer that is not an image, or is too big without saying so, is refused', async () => {
    const big = new Uint8Array(icons.ICON_MAX_BYTES + 1)
    const { fetchImpl } = fakeFetch({
      'https://x.example/page': () => new Response('<script>', { headers: { 'content-type': 'text/html' } }),
      'https://x.example/big.png': () => new Response(big, { headers: { 'content-type': 'image/png' } }),
    })
    expect(await icons.iconDataUri({ src: 'https://x.example/page' }, fetchImpl)).toBeNull()
    expect(await icons.iconDataUri({ src: 'https://x.example/big.png' }, fetchImpl)).toBeNull()
  })

  test('an inline image is kept as it is, and an inline non-image is refused, with no fetch', async () => {
    const { calls, fetchImpl } = fakeFetch({})
    expect(await icons.iconDataUri({ src: 'data:image/png;base64,iVBO' }, fetchImpl)).toBe('data:image/png;base64,iVBO')
    expect(await icons.iconDataUri({ src: 'data:text/html,<b>' }, fetchImpl)).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('IntegrationIcons', () => {
  test('saves the icon once, tells the listeners, and does not fetch the same address again', async () => {
    const { calls, fetchImpl } = fakeFetch({ 'https://x.example/a.png': png })
    const store = new icons.IntegrationIcons(fetchImpl)
    const changed: string[] = []
    store.onChanged((id) => changed.push(id))
    const served: Icon[] = [{ src: 'https://x.example/a.png' }]

    await store.refresh('int-a', served)
    await store.refresh('int-a', served)

    expect(store.get('int-a')?.light).toStartWith('data:image/png;base64,')
    expect(calls).toEqual(['https://x.example/a.png'])
    expect(changed).toEqual(['int-a'])
  })

  test('a fetch that fails keeps the icon the host had', async () => {
    let isDown = false
    const { fetchImpl } = fakeFetch({ 'https://x.example/b.png': () => (isDown ? new Response('', { status: 503 }) : png()) })
    let now = 0
    const store = new icons.IntegrationIcons(fetchImpl, () => now)
    await store.refresh('int-b', [{ src: 'https://x.example/b.png' }])
    isDown = true
    now = 8 * 24 * 60 * 60 * 1000
    await store.refresh('int-b', [{ src: 'https://x.example/b.png' }])
    expect(store.get('int-b')).not.toBeNull()
  })

  test('a server that stops naming an icon loses it, and the clients hear of it', async () => {
    const { fetchImpl } = fakeFetch({ 'https://x.example/c.png': png })
    const store = new icons.IntegrationIcons(fetchImpl)
    const changed: string[] = []
    await store.refresh('int-c', [{ src: 'https://x.example/c.png' }])
    store.onChanged((id) => changed.push(id))
    await store.refresh('int-c', undefined)
    expect(store.get('int-c')).toBeNull()
    expect(changed).toEqual(['int-c'])
  })
})
