import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { clientFor } from '@solus/server/providers/github/octokit'
import { fakeGithubCredentials } from './helpers/github-credentials'

/**
 * `gh config set http_unix_socket` puts a credential proxy in front of GitHub:
 * `gh auth token` prints a placeholder, and only the proxy on that socket can
 * swap in the real token. A `gh` credential with a socket must therefore send
 * every REST and GraphQL request through the socket, and never to GitHub
 * itself, where the placeholder fails as a 401.
 */

interface SeenRequest {
  method: string | undefined
  path: string | undefined
  headers: IncomingHttpHeaders
  body: string
}

// The credential chain reads the acting person; with no caller, it acts as the host (plans/019).
actAsHostForTests()

const realFetch = globalThis.fetch
const cleanups: Array<() => void> = []
afterEach(() => {
  globalThis.fetch = realFetch
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function socketProxy(): Promise<{ socketPath: string; seen: SeenRequest[] }> {
  const directory = mkdtempSync(join(tmpdir(), 'solus-gh-socket-'))
  const socketPath = join(directory, 'api.sock')
  const seen: SeenRequest[] = []
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    seen.push({ method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() })
    if (request.url === '/repos/acme/old-name') {
      response.writeHead(301, { location: 'https://api.github.com/repos/acme/app' })
      response.end()
      return
    }
    response.setHeader('content-type', 'application/json')
    if (request.url === '/graphql') response.end(JSON.stringify({ data: { viewer: { login: 'proxy-user' } } }))
    else response.end(JSON.stringify({ full_name: 'acme/app' }))
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  cleanups.push(() => {
    server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { socketPath, seen }
}

describe('GitHub through gh http_unix_socket', () => {
  test('a gh credential sends REST and GraphQL over the socket and nothing to GitHub directly', async () => {
    const { socketPath, seen } = await socketProxy()
    const direct: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      direct.push(String(input))
      return new Response('{}', { status: 401 })
    }) as typeof fetch
    const { credentials } = fakeGithubCredentials({
      gh: new Map([['github.com', 'placeholder-socket-token']]),
      ghUnixSocket: `${socketPath}\n`,
    })
    const [credential] = await credentials.chain('github.com')
    expect(credential).toEqual({ source: 'gh-cli', token: 'placeholder-socket-token', unixSocket: socketPath })
    const client = clientFor(credential)

    const repo = await client.rest.repos.get({ owner: 'acme', repo: 'old-name' })
    expect(repo.data.full_name).toBe('acme/app')
    const viewer = await client.graphql<{ viewer: { login: string } }>('query Viewer { viewer { login } }')
    expect(viewer.viewer.login).toBe('proxy-user')

    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /repos/acme/old-name',
      'GET /repos/acme/app',
      'POST /graphql',
    ])
    for (const request of seen) {
      expect(request.headers.host).toBe('api.github.com')
      expect(request.headers.authorization?.endsWith('placeholder-socket-token')).toBe(true)
    }
    expect(JSON.parse(seen[2].body).query).toBe('query Viewer { viewer { login } }')
    expect(direct).toEqual([])
  })

  test('a gh credential without the setting talks to GitHub as before', async () => {
    const { credentials } = fakeGithubCredentials({ gh: new Map([['github.com', 'gh-token']]) })
    expect(await credentials.chain('github.com')).toEqual([{ source: 'gh-cli', token: 'gh-token' }])
  })

  test('when the socket is gone the request fails instead of going to GitHub', async () => {
    const direct: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      direct.push(String(input))
      return new Response('{}')
    }) as typeof fetch
    const client = clientFor({ source: 'gh-cli', token: 'gone-socket-token', unixSocket: join(tmpdir(), 'solus-no-such.sock') })
    await expect(client.rest.repos.get({ owner: 'acme', repo: 'app' })).rejects.toThrow()
    expect(direct).toEqual([])
  })
})
