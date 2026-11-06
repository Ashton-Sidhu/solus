import { afterEach, describe, expect, test } from 'bun:test'
import type { IpcContext } from '@solus/contracts/types'
import { githubMediaFetchUrl, githubMediaUrl } from '@solus/contracts/github-media'
import { verifyAssetToken } from '@solus/server/data/assets/assets'
import { actAsHostForTests, HOST_IDENTITY, HOST_SCOPE, useActingIdentities } from '@solus/server/execution/seats/acting-identity'
import { GitHubRateLimitedError } from '@solus/server/providers/github/rate-limit'
import { signToken } from '@solus/server/admission/signed-token'
import { currentPersonKey, useActingScopeSource, withActingScope } from '@solus/server/vault/acting-scope'
import {
  createGithubMediaUrl,
  readGithubMediaToken,
  serveGithubMedia,
  type GithubMediaFetchDeps,
} from '@solus/server/providers/github/media'

actAsHostForTests()

const secret = Buffer.alloc(32, 9)
const now = 1_000_000
const ctx = { session: { projectPath: '/repo', workingDirectory: '/repo' } } as IpcContext
const ATTACHMENT = 'https://github.com/user-attachments/assets/3f2a9c1e-0000-4000-8000-000000000001'
const SIGNED_OBJECT = 'https://private-user-images.githubusercontent.com/1/shot.png?jwt=signed'

const PR_REPOSITORY = 'enterprise/private'
const SIGN_IN_PAGE = () => new Response('<html>Sign in with SSO</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
const signedUpload = (generation: number) => `https://private-user-images.githubusercontent.com/1/upload.mp4?jwt=render-${generation}&x=1`
const VIDEO = () => new Response('video', { status: 200, headers: { 'content-type': 'video/mp4' } })

const tokenOf = (relativeUrl: string) => relativeUrl.replace('/api/assets/', '')

interface Fetched { url: string; authorization: string | null; range: string | null; method: string | undefined }
interface Rendered { token: string; text: string; repository: string }

/** A GitHub that answers each URL from `routes`, and records who carried a token. */
function githubFetch(routes: { [url: string]: () => Response }, tokens: string[] = ['host-token']): GithubMediaFetchDeps & { fetched: Fetched[]; rendered: Rendered[]; clock: { now: number } } {
  const fetched: Fetched[] = []
  const rendered: Rendered[] = []
  const clock = { now }
  return {
    fetched,
    rendered,
    clock,
    now: () => clock.now,
    signedUrls: new Map(),
    credentials: async () => tokens.map((token) => ({ source: 'host' as const, token })),
    // GitHub signs the upload for a repository the account can read, and hands the URL back HTML-escaped.
    renderMarkdown: async (credential, text, repository) => {
      rendered.push({ token: credential.token, text, repository })
      return `<p><img src="${signedUpload(rendered.length).replaceAll('&', '&amp;')}" alt=""></p>`
    },
    fetch: async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      fetched.push({ url, authorization: headers.get('authorization'), range: headers.get('range'), method: init?.method })
      const route = routes[url]
      return route ? route() : new Response(null, { status: 404 })
    },
  }
}

function signedMedia(source = ATTACHMENT, repository?: string) {
  const { relativeUrl, expiresAt } = createGithubMediaUrl(ctx, source, { secret, now, repository })
  const payload = readGithubMediaToken(tokenOf(relativeUrl), secret, now)
  if (!payload) throw new Error('the token did not verify')
  return { relativeUrl, expiresAt, payload }
}

describe('media in text written on GitHub', () => {
  test('a root-relative address is on github.com, so a host can sign it', () => {
    // WHY: a browser resolves it against the Solus origin, and a phone reads it as a file.
    expect(githubMediaUrl('/acme/app/raw/main/a.png')).toBe('https://github.com/acme/app/raw/main/a.png')
    expect(githubMediaFetchUrl(githubMediaUrl('/acme/app/raw/main/a.png'))).toBe('https://raw.githubusercontent.com/acme/app/main/a.png')
  })

  test('any other address stays as it is', () => {
    for (const source of ['https://example.com/a.png', '//example.com/a.png', '/\\example.com/a.png', 'docs/a.png', './a.png']) {
      expect(githubMediaUrl(source)).toBe(source)
    }
  })
})

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

describe('the signed token', () => {
  test('keeps the repository of the pull request, and the signature covers it', () => {
    expect(signedMedia(ATTACHMENT, PR_REPOSITORY).payload.repository).toBe(PR_REPOSITORY)
    const { relativeUrl } = signedMedia(ATTACHMENT, PR_REPOSITORY)
    const [body, signature] = tokenOf(relativeUrl).split('.')
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), repository: 'other/repo' })).toString('base64url')
    expect(readGithubMediaToken(`${tampered}.${signature}`, secret, now)).toBeNull()
  })

  test('a call with no repository signs none, and the wire may carry that as null', () => {
    expect(signedMedia().payload.repository).toBeUndefined()
    // WHY: JSON turns an omitted trailing argument into null over a WebSocket.
    const overTheWire = createGithubMediaUrl(ctx, ATTACHMENT, { secret, now, repository: null as never })
    expect(readGithubMediaToken(tokenOf(overTheWire.relativeUrl), secret, now)?.repository).toBeUndefined()
  })

  test('refuses a repository that is not owner/name', () => {
    // WHY: the value comes from a client, and the host renders with a credential in its context.
    for (const repository of ['just-a-name', 'a/b/c', '../../etc', 'a b/c', `o/${'r'.repeat(101)}`, ['a/b'] as never]) {
      expect(() => signedMedia(ATTACHMENT, repository)).toThrow('A pull request repository must be owner/name.')
    }
  })

  test('a token from before the person was signed does not read as the host', () => {
    // WHY: on a shared host, a token that names nobody must not fetch with the host's credential.
    const old = signToken({ githubMediaUrl: ATTACHMENT, expiresAt: now + 1000 }, secret)
    expect(readGithubMediaToken(old, secret, now)).toBeNull()
  })
})

describe('whose GitHub access a signed URL uses', () => {
  afterEach(() => useActingIdentities(null))

  test('the person who signed it, on a request that has no scope of its own', async () => {
    useActingScopeSource({ scopeForUser: (personKey) => (personKey ? { identity: HOST_IDENTITY, personKey } : HOST_SCOPE) })
    const mint = (personKey: string) => withActingScope({ identity: HOST_IDENTITY, personKey }, () =>
      readGithubMediaToken(tokenOf(createGithubMediaUrl(ctx, ATTACHMENT, { secret, now }).relativeUrl), secret, now)!)
    const deps = githubFetch({ [ATTACHMENT]: VIDEO })
    deps.credentials = async () => [{ source: 'account', token: `token-of-${currentPersonKey()}` }]

    await serveGithubMedia(mint('user:a'), { method: 'GET' }, deps)
    await serveGithubMedia(mint('user:b'), { method: 'GET' }, deps)

    expect(deps.fetched.map((request) => request.authorization)).toEqual(['Bearer token-of-user:a', 'Bearer token-of-user:b'])
  })
})

describe('an upload in an organization that enforces SAML SSO', () => {
  test('renders the upload in the pull request repository and fetches the signed URL with no token', async () => {
    const deps = githubFetch({ [ATTACHMENT]: SIGN_IN_PAGE, [signedUpload(1)]: VIDEO })

    const response = await serveGithubMedia(signedMedia(ATTACHMENT, PR_REPOSITORY).payload, { method: 'GET', range: 'bytes=2-5' }, deps)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('video')
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(deps.rendered).toEqual([{ token: 'host-token', text: `![](${ATTACHMENT})`, repository: PR_REPOSITORY }])
    expect(deps.fetched.map((request) => [request.url, request.authorization, request.range])).toEqual([
      [ATTACHMENT, 'Bearer host-token', 'bytes=2-5'],
      [signedUpload(1), null, 'bytes=2-5'],
    ])
    // WHY: the client must never see the signed URL or the credential.
    expect([...response.headers.values()].join(' ')).not.toContain('jwt')
  })

  test('with no repository, an upload answers as it did before: no render, and not media', async () => {
    const deps = githubFetch({ [ATTACHMENT]: SIGN_IN_PAGE })
    const response = await serveGithubMedia(signedMedia().payload, { method: 'GET' }, deps)
    expect(response.status).toBe(415)
    expect(deps.rendered).toEqual([])
    expect(deps.fetched).toHaveLength(1)
  })

  test('a legacy upload renders in the repository its path names, whatever the client said', async () => {
    const legacy = 'https://github.com/acme/app/assets/123/abc-def'
    const deps = githubFetch({ [legacy]: SIGN_IN_PAGE, [signedUpload(1)]: VIDEO })
    const response = await serveGithubMedia(signedMedia(legacy, 'personal/unrelated').payload, { method: 'GET' }, deps)
    expect(response.status).toBe(200)
    expect(deps.rendered.map((render) => render.repository)).toEqual(['acme/app'])
  })

  test('only an upload is rendered', async () => {
    const raw = 'https://raw.githubusercontent.com/acme/app/main/shot.png'
    const deps = githubFetch({ [raw]: SIGN_IN_PAGE })
    await serveGithubMedia(signedMedia(raw, PR_REPOSITORY).payload, { method: 'GET' }, deps)
    expect(deps.rendered).toEqual([])
  })

  test('a range uses the cached signed URL, with no second render or upload request', async () => {
    const deps = githubFetch({ [ATTACHMENT]: SIGN_IN_PAGE, [signedUpload(1)]: VIDEO })
    const { payload } = signedMedia(ATTACHMENT, PR_REPOSITORY)
    await serveGithubMedia(payload, { method: 'GET' }, deps)
    await serveGithubMedia(payload, { method: 'GET', range: 'bytes=0-1' }, deps)
    expect(deps.rendered).toHaveLength(1)
    expect(deps.fetched.map((request) => request.url)).toEqual([ATTACHMENT, signedUpload(1), signedUpload(1)])
  })

  test('a cached 403 renders a new URL and answers with the media', async () => {
    let expired = false
    const deps = githubFetch({
      [ATTACHMENT]: SIGN_IN_PAGE,
      [signedUpload(1)]: () => expired ? new Response(null, { status: 403 }) : VIDEO(),
      [signedUpload(2)]: VIDEO,
    })
    const { payload } = signedMedia(ATTACHMENT, PR_REPOSITORY)
    await serveGithubMedia(payload, { method: 'GET' }, deps)
    expired = true

    const response = await serveGithubMedia(payload, { method: 'GET' }, deps)

    expect(response.status).toBe(200)
    expect(deps.rendered).toHaveLength(2)
    expect(deps.fetched.at(-1)).toMatchObject({ url: signedUpload(2), authorization: null })
    // The new URL replaced the old one.
    await serveGithubMedia(payload, { method: 'GET' }, deps)
    expect(deps.rendered).toHaveLength(2)
    expect(deps.fetched.at(-1)?.url).toBe(signedUpload(2))
  })

  test('a signed URL whose media failed to load is not cached', async () => {
    const deps = githubFetch({
      [ATTACHMENT]: SIGN_IN_PAGE,
      [signedUpload(1)]: () => new Response(null, { status: 503 }),
      [signedUpload(2)]: VIDEO,
    })
    const { payload } = signedMedia(ATTACHMENT, PR_REPOSITORY)

    expect((await serveGithubMedia(payload, { method: 'GET' }, deps)).status).toBe(502)
    expect(deps.signedUrls.size).toBe(0)

    expect((await serveGithubMedia(payload, { method: 'GET' }, deps)).status).toBe(200)
    expect(deps.rendered).toHaveLength(2)
  })

  test('a signed URL does not outlive its time limit', async () => {
    const deps = githubFetch({ [ATTACHMENT]: SIGN_IN_PAGE, [signedUpload(1)]: VIDEO, [signedUpload(2)]: VIDEO })
    const { payload } = signedMedia(ATTACHMENT, PR_REPOSITORY)
    await serveGithubMedia(payload, { method: 'GET' }, deps)
    deps.clock.now += 4 * 60_000
    await serveGithubMedia({ ...payload, expiresAt: deps.clock.now + 1000 }, { method: 'GET' }, deps)
    expect(deps.rendered).toHaveLength(2)
    expect(deps.signedUrls.size).toBe(1)
  })

  test('the cache holds a fixed number of URLs, and drops the oldest', async () => {
    const routes: { [url: string]: () => Response } = { [signedUpload(65)]: VIDEO }
    const uploads = Array.from({ length: 65 }, (_, index) => {
      const upload = `${ATTACHMENT.slice(0, -2)}${String(index).padStart(2, '0')}`
      routes[upload] = SIGN_IN_PAGE
      routes[signedUpload(index + 1)] = VIDEO
      return upload
    })
    const deps = githubFetch(routes)
    for (const upload of uploads) await serveGithubMedia(signedMedia(upload, PR_REPOSITORY).payload, { method: 'GET' }, deps)
    expect(deps.signedUrls.size).toBe(64)
    await serveGithubMedia(signedMedia(uploads[0], PR_REPOSITORY).payload, { method: 'GET' }, deps)
    expect(deps.rendered).toHaveLength(66)
  })

  test('one account never gets the signed URL of another, or of another repository', async () => {
    // WHY: on a shared host a signed URL is a read of a private upload.
    const routes = { [ATTACHMENT]: SIGN_IN_PAGE, [signedUpload(1)]: VIDEO, [signedUpload(2)]: VIDEO, [signedUpload(3)]: VIDEO }
    const deps = githubFetch(routes, ['token-a'])
    const { payload } = signedMedia(ATTACHMENT, PR_REPOSITORY)
    await serveGithubMedia(payload, { method: 'GET' }, deps)
    deps.credentials = async () => [{ source: 'account', token: 'token-b' }]
    await serveGithubMedia(payload, { method: 'GET' }, deps)
    await serveGithubMedia(signedMedia(ATTACHMENT, 'enterprise/other').payload, { method: 'GET' }, deps)
    expect(deps.rendered.map((render) => [render.token, render.repository])).toEqual([
      ['token-a', PR_REPOSITORY],
      ['token-b', PR_REPOSITORY],
      ['token-b', 'enterprise/other'],
    ])
    // WHY: this map outlives the request, so it must not hold a credential.
    expect([...deps.signedUrls.keys()].join(' ')).not.toContain('token-')
  })

  test('moves down the chain when one account gets no signed URL', async () => {
    const deps = githubFetch({ [ATTACHMENT]: SIGN_IN_PAGE, [signedUpload(1)]: VIDEO }, ['no-access', 'has-access'])
    const render = deps.renderMarkdown
    deps.renderMarkdown = async (credential, text, repository) => credential.token === 'no-access'
      ? `<p><img src="${ATTACHMENT}" alt=""></p>`
      : render(credential, text, repository)
    const response = await serveGithubMedia(signedMedia(ATTACHMENT, PR_REPOSITORY).payload, { method: 'GET' }, deps)
    expect(response.status).toBe(200)
    expect(deps.fetched.map((request) => request.authorization)).toEqual(['Bearer no-access', 'Bearer has-access', null])
  })

  test('a rate limit ends the chain, as it does for every GitHub request', async () => {
    const deps = githubFetch({ [ATTACHMENT]: SIGN_IN_PAGE }, ['first', 'second'])
    deps.renderMarkdown = async () => { throw new GitHubRateLimitedError(null) }
    const response = await serveGithubMedia(signedMedia(ATTACHMENT, PR_REPOSITORY).payload, { method: 'GET' }, deps)
    expect(response.status).toBe(502)
    expect(deps.fetched.map((request) => request.authorization)).toEqual(['Bearer first'])
  })

  test('accepts only an HTTPS signed URL on the upload host', async () => {
    for (const html of [
      '<img src="https://evil.example/x.png?jwt=1">',
      '<img src="http://private-user-images.githubusercontent.com/1/x.png?jwt=1">',
      '<img src="https://private-user-images.githubusercontent.com:8443/1/x.png?jwt=1">',
      '<img src="https://private-user-images.githubusercontent.com/1/x.png">',
    ]) {
      const deps = githubFetch({ [ATTACHMENT]: SIGN_IN_PAGE })
      deps.renderMarkdown = async () => html
      const response = await serveGithubMedia(signedMedia(ATTACHMENT, PR_REPOSITORY).payload, { method: 'GET' }, deps)
      expect(response.status).toBe(403)
      expect(deps.fetched).toHaveLength(1)
    }
  })

  test('a HEAD request reads the signed URL with the GET it was signed for', async () => {
    const deps = githubFetch({ [ATTACHMENT]: SIGN_IN_PAGE, [signedUpload(1)]: VIDEO })
    const response = await serveGithubMedia(signedMedia(ATTACHMENT, PR_REPOSITORY).payload, { method: 'HEAD' }, deps)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(deps.fetched.at(-1)).toMatchObject({ url: signedUpload(1), method: 'GET' })
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

  test('a redirect to another port of a GitHub host gets no token', async () => {
    const elsewhere = 'https://github.com:8443/shot.png'
    const deps = githubFetch({
      [ATTACHMENT]: () => new Response(null, { status: 302, headers: { location: elsewhere } }),
      [elsewhere]: () => new Response('png', { status: 200, headers: { 'content-type': 'image/png' } }),
    })
    await serveGithubMedia(signedMedia().payload, { method: 'GET' }, deps)
    expect(deps.fetched.at(-1)).toMatchObject({ url: elsewhere, authorization: null })
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
