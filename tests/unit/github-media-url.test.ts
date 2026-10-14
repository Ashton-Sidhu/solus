import { describe, expect, test } from 'bun:test'
import type { IpcContext } from '@solus/contracts/types'
import { githubMediaFetchUrl } from '@solus/contracts/github-media'
import { verifyAssetToken } from '@solus/server/data/assets/assets'
import {
  createGithubMediaUrl,
  readGithubMediaToken,
  serveGithubMedia,
  type GithubMediaFetchDeps,
} from '@solus/server/providers/github/media'

const secret = Buffer.alloc(32, 9)
const now = 1_000_000
const ctx = { session: { projectPath: '/repo', workingDirectory: '/repo' } } as IpcContext
const ATTACHMENT = 'https://github.com/user-attachments/assets/3f2a9c1e-0000-4000-8000-000000000001'
const SIGNED_OBJECT = 'https://private-user-images.githubusercontent.com/1/shot.png?jwt=signed'

const tokenOf = (relativeUrl: string) => relativeUrl.replace('/api/assets/', '')

interface Fetched { url: string; authorization: string | null; range: string | null }

/** A GitHub that answers each URL from `routes`, and records who carried a token. */
function githubFetch(routes: { [url: string]: () => Response }, tokens: string[] = ['host-token']): GithubMediaFetchDeps & { fetched: Fetched[] } {
  const fetched: Fetched[] = []
  return {
    fetched,
    now: () => now,
    tokens: async () => tokens,
    fetch: async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      fetched.push({ url, authorization: headers.get('authorization'), range: headers.get('range') })
      const route = routes[url]
      return route ? route() : new Response(null, { status: 404 })
    },
  }
}

function signedMedia(source = ATTACHMENT) {
  const { relativeUrl, expiresAt } = createGithubMediaUrl(ctx, source, { secret, now })
  const payload = readGithubMediaToken(tokenOf(relativeUrl), secret, now)
  if (!payload) throw new Error('the token did not verify')
  return { relativeUrl, expiresAt, payload }
}

describe('which URLs the host fetches with its GitHub credential', () => {
  test('attachments, committed files and LFS media; nothing else', () => {
    expect(githubMediaFetchUrl(ATTACHMENT)).toBe(ATTACHMENT)
    expect(githubMediaFetchUrl('https://github.com/acme/app/blob/main/docs/shot.png?raw=true'))
      .toBe('https://raw.githubusercontent.com/acme/app/main/docs/shot.png')
    expect(githubMediaFetchUrl('https://media.githubusercontent.com/media/acme/app/main/demo.mp4'))
      .toBe('https://media.githubusercontent.com/media/acme/app/main/demo.mp4')
    // WHY: a signed object URL authorizes itself; a token cannot help it, and a
    // host that fetched any URL with its token would hand that token to anyone.
    expect(githubMediaFetchUrl(SIGNED_OBJECT)).toBeNull()
    expect(githubMediaFetchUrl('https://example.com/user-attachments/assets/abc')).toBeNull()
    expect(githubMediaFetchUrl('http://github.com/user-attachments/assets/abc')).toBeNull()
    expect(githubMediaFetchUrl('https://github.com/acme/app/pull/1')).toBeNull()
  })

  test('signs only GitHub media, and its token is not a file token', () => {
    expect(() => createGithubMediaUrl(ctx, 'https://example.com/shot.png', { secret, now }))
      .toThrow('Only media that GitHub hosts can be fetched with the GitHub credential.')
    const { relativeUrl, expiresAt } = signedMedia()
    expect(relativeUrl.startsWith('/api/assets/')).toBe(true)
    expect(expiresAt).toBe(now + 60 * 60 * 1000)
    // WHY: one secret signs both kinds; a GitHub media token must never be
    // read as a path on the host, nor a path token as a GitHub fetch.
    expect(verifyAssetToken(tokenOf(relativeUrl), secret, now)).toBeNull()
    expect(readGithubMediaToken(tokenOf(relativeUrl), secret, expiresAt)).toBeNull()
  })
})

describe('serving GitHub media from the host origin', () => {
  test('sends the token to GitHub only, never to the signed object a redirect leads to', async () => {
    const deps = githubFetch({
      [ATTACHMENT]: () => new Response(null, { status: 302, headers: { location: SIGNED_OBJECT } }),
      [SIGNED_OBJECT]: () => new Response('png-bytes', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '9' } }),
    })

    const response = await serveGithubMedia(signedMedia().payload, { method: 'GET' }, deps)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('png-bytes')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(deps.fetched.map((request) => [request.url, request.authorization])).toEqual([
      [ATTACHMENT, 'Bearer host-token'],
      [SIGNED_OBJECT, null],
    ])
  })

  test('passes a byte range on, so a video seeks without a full download', async () => {
    const deps = githubFetch({
      [ATTACHMENT]: () => new Response('mp', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1/10' } }),
    })

    const response = await serveGithubMedia(signedMedia().payload, { method: 'GET', range: 'bytes=0-1' }, deps)

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-1/10')
    expect(deps.fetched[0].range).toBe('bytes=0-1')
  })

  test('tries the next credential when GitHub refuses one', async () => {
    let calls = 0
    const deps = githubFetch({
      [ATTACHMENT]: () => ++calls === 1
        ? new Response(null, { status: 404 })
        : new Response('gif', { status: 200, headers: { 'content-type': 'image/gif' } }),
    }, ['host-token', 'gh-token'])

    const response = await serveGithubMedia(signedMedia().payload, { method: 'GET' }, deps)

    expect(response.status).toBe(200)
    expect(deps.fetched.map((request) => request.authorization)).toEqual(['Bearer host-token', 'Bearer gh-token'])
  })

  test('answers a refusal with its status and no body, and refuses anything that is not media', async () => {
    const missing = await serveGithubMedia(signedMedia().payload, { method: 'GET' }, githubFetch({}))
    expect(missing.status).toBe(404)

    const page = 'https://raw.githubusercontent.com/acme/app/main/index.html'
    const html = await serveGithubMedia(signedMedia('https://github.com/acme/app/raw/main/index.html').payload, { method: 'GET' }, githubFetch({
      [page]: () => new Response('<script>', { status: 200, headers: { 'content-type': 'text/html' } }),
    }))
    // WHY: the host origin serves the client app. HTML from a pull request
    // must never run there.
    expect(html.status).toBe(415)
  })

  test('names a committed binary by its file name, and fences an SVG off from script', async () => {
    const png = 'https://raw.githubusercontent.com/acme/app/main/shot.png'
    const svg = 'https://raw.githubusercontent.com/acme/app/main/logo.svg'
    const deps = githubFetch({
      [png]: () => new Response('png', { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      [svg]: () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
    })

    const pngResponse = await serveGithubMedia(signedMedia(png).payload, { method: 'GET' }, deps)
    const svgResponse = await serveGithubMedia(signedMedia(svg).payload, { method: 'GET' }, deps)

    expect(pngResponse.headers.get('content-type')).toBe('image/png')
    expect(svgResponse.headers.get('content-security-policy')).toContain('sandbox')
  })
})
