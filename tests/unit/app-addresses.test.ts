import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AppAddress, TailscaleServeStatus } from '@solus/contracts/host-api'

// Bun has no node:sqlite; the handler reaches the database through the host's installation id.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { appAddressesOf, probeAppAddress } = await import('@solus/server/transport/app-addresses')
const { protectedResourceMetadata } = await import('@solus/server/transport/mcp-oauth')
const { SolusServer } = await import('@solus/server/transport/server')
const { registerConnectionsHandlers } = await import('@solus/server/transport/handlers/connections-handlers')
const settings = await import('@solus/server/host/settings')

// WHY: a host does not have to be linked to a Solus account for outside apps to
// use its /mcp (plans/035 §0.8). Tailscale or the person's own ingress serves it
// too, and the client shows each address with who can reach it.

const off: Pick<TailscaleServeStatus, 'state' | 'url' | 'funnel'> = { state: 'off', url: null, funnel: false }
const serve = (funnel: boolean): Pick<TailscaleServeStatus, 'state' | 'url' | 'funnel'> => ({ state: 'active', url: 'https://box.tail.ts.net', funnel })

describe('the addresses an outside app reaches', () => {
  test('the internet ones come first: the Solus tunnel, Tailscale Funnel, the own ingress; then the tailnet', () => {
    expect(appAddressesOf({ tunnel: 'https://h1.solus.dev', serve: serve(true), publicAddress: 'https://solus.example.com' })).toEqual([
      { source: 'solus', url: 'https://h1.solus.dev/mcp', reach: 'internet' },
      { source: 'tailscale-funnel', url: 'https://box.tail.ts.net/mcp', reach: 'internet' },
      { source: 'custom', url: 'https://solus.example.com/mcp', reach: 'internet' },
    ])
    expect(appAddressesOf({ tunnel: null, serve: serve(false), publicAddress: 'https://solus.example.com' })).toEqual([
      { source: 'custom', url: 'https://solus.example.com/mcp', reach: 'internet' },
      { source: 'tailscale-serve', url: 'https://box.tail.ts.net/mcp', reach: 'tailnet' },
    ])
  })

  test('a host with no account, no Tailscale, and no ingress has none; a Serve mapping that is not active gives none', () => {
    expect(appAddressesOf({ tunnel: null, serve: off, publicAddress: '' })).toEqual([])
    expect(appAddressesOf({ tunnel: null, serve: { state: 'other', url: 'https://box.tail.ts.net', funnel: false }, publicAddress: '' })).toEqual([])
  })
})

function connections(facts: { tunnel?: string | null; serve?: Pick<TailscaleServeStatus, 'state' | 'url' | 'funnel'>; publicAddress?: string }) {
  const server = new SolusServer()
  const status: TailscaleServeStatus = { enabled: facts.serve?.state === 'active', port: 443, error: null, ...(facts.serve ?? off) }
  // SAFETY: the app address methods read only these dependencies.
  registerConnectionsHandlers(server, {
    getServerInfo: () => ({ port: 4000 }),
    tunnelUrl: () => facts.tunnel ?? null,
    getTailscaleServe: async () => status,
    publicAddress: () => facts.publicAddress ?? '',
  } as never)
  const owner = { kind: 'owner' as const, via: 'local' as const, deviceId: 'd', deviceLabel: 'Mac', expiresAt: null }
  return {
    endpoint: () => server.handle('connectionsAppEndpoint', [], { clientId: 'ws:test', principal: owner }),
    test: (args: object) => server.handle('connectionsTestAppAddress', [args as never], { clientId: 'ws:test', principal: owner }),
  }
}

describe('connectionsAppEndpoint', () => {
  test('publicUrl is the first internet address, else null; the tailnet address is listed but is not public', async () => {
    expect(await connections({ serve: serve(false), publicAddress: 'https://solus.example.com' }).endpoint()).toEqual({
      localUrl: 'http://localhost:4000/mcp',
      publicUrl: 'https://solus.example.com/mcp',
      addresses: [
        { source: 'custom', url: 'https://solus.example.com/mcp', reach: 'internet' },
        { source: 'tailscale-serve', url: 'https://box.tail.ts.net/mcp', reach: 'tailnet' },
      ],
    })
    expect((await connections({ serve: serve(false) }).endpoint()).publicUrl).toBeNull()
  })
})

// WHY: a person who may use the host asks it to fetch an address. If the caller
// could name the URL, the host would fetch anything its network reaches for them
// (SSRF): a cloud metadata service, a router page. So the caller names only a
// source, and the host fetches only the address it lists for that source.
describe('connectionsTestAppAddress asks only an address the host lists', () => {
  afterEach(() => { mock.restore() })

  test('takes a source, never a URL, and fetches only that listed address', async () => {
    const fetched: string[] = []
    spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
      fetched.push(String(input))
      return new Response('{}', { status: 404 })
    }) as typeof fetch)
    const rpc = connections({ publicAddress: 'https://solus.example.com' })
    expect(rpc.test({ source: 'custom', url: 'http://169.254.169.254/latest' })).rejects.toThrow()
    expect(rpc.test({ url: 'http://169.254.169.254/latest' })).rejects.toThrow()
    expect(await rpc.test({ source: 'tailscale-funnel' })).toEqual({ reachable: false, reason: 'This host has no address from that source now.' })
    await rpc.test({ source: 'custom' })
    expect(fetched).toEqual(['https://solus.example.com/.well-known/oauth-protected-resource/mcp'])
  })

  test('follows no redirect: an address that sends the host elsewhere is a wrong answer', async () => {
    const fetchImpl = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
    })
    const result = await probeAppAddress(CUSTOM, { installationId: 'this-host', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.reachable).toBe(false)
    expect(result.reason).toContain('redirect')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

const CUSTOM: AppAddress = { source: 'custom', url: 'https://solus.example.com/mcp', reach: 'internet' }
const FUNNEL: AppAddress = { source: 'tailscale-funnel', url: 'https://box.tail.ts.net/mcp', reach: 'internet' }

/** A fetch that answers as a Solus host at its address would: the real metadata, and `/health` with its id. */
function solusAnswers(installationId: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname === '/health') return Response.json({ ok: true, installationId })
    return protectedResourceMetadata(new Request(url, { headers: { host: url.host } }))
  }) as typeof fetch
}

function failing(error: unknown): typeof fetch {
  return (async () => { throw error }) as typeof fetch
}

const codeError = (code: string, message = code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) })

// WHY: the person reads the reason to fix their setup, so it must name the real
// cause, and it must not call a Funnel address down only because this host
// cannot reach its own Funnel (hairpin).
describe('the probe of one address', () => {
  afterEach(() => { settings.setHostConfig({ publicAddress: '' }) })

  test('a Solus host that names this /mcp as its resource, and is this host, is reachable', async () => {
    expect(await probeAppAddress(FUNNEL, { installationId: 'this-host', fetchImpl: solusAnswers('this-host') })).toEqual({ reachable: true, reason: null })
    settings.setHostConfig({ publicAddress: 'https://solus.example.com' })
    expect(await probeAppAddress(CUSTOM, { installationId: 'this-host', fetchImpl: solusAnswers('this-host') })).toEqual({ reachable: true, reason: null })
  })

  test('names DNS, TLS, a timeout, and a refused connection', async () => {
    const reason = async (fetchImpl: typeof fetch, address = CUSTOM) => (await probeAppAddress(address, { installationId: 'this-host', fetchImpl })).reason ?? ''
    expect(await reason(failing(codeError('ENOTFOUND')))).toContain('does not resolve from this host (DNS)')
    expect(await reason(failing(codeError('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames")))).toContain('certificate of solus.example.com is not valid')
    expect(await reason(failing(new DOMException('The operation timed out.', 'TimeoutError')))).toContain('did not answer in 5 seconds')
    expect(await reason(failing(codeError('ECONNREFUSED')))).toContain('Nothing accepts the connection')
  })

  test('names a wrong answer, and an answer from something that is not Solus or not this host', async () => {
    const reason = async (fetchImpl: typeof fetch) => (await probeAppAddress(CUSTOM, { installationId: 'this-host', fetchImpl })).reason ?? ''
    expect(await reason((async () => new Response('Bad gateway', { status: 502 })) as typeof fetch)).toContain('HTTP 502, not with Solus. The proxy there cannot reach this host.')
    expect(await reason((async () => new Response('<html>parked domain</html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch)).toBe('Something that is not Solus answers at https://solus.example.com.')
    // A proxy that forwards to another name: Solus names the address it was asked at.
    const otherName = (async () => protectedResourceMetadata(new Request('https://internal.example.net/.well-known/oauth-protected-resource/mcp'))) as typeof fetch
    expect(await reason(otherName)).toBe('https://solus.example.com names https://internal.example.net/mcp as its MCP address, not https://solus.example.com/mcp. Check that the proxy sends the Host or X-Forwarded-Host and X-Forwarded-Proto headers.')
    // WHY: a proxy that rewrites Host to the upstream and sends no forwarded header makes every
    // request from the internet look like a request from this machine. The test must say so plainly.
    const rewritesHost = (async () => protectedResourceMetadata(new Request('http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp'))) as typeof fetch
    expect(await reason(rewritesHost)).toContain('reads every request through it as a request from this machine. Fix the proxy before you use this address')
    settings.setHostConfig({ publicAddress: 'https://solus.example.com' })
    expect(await reason(solusAnswers('another-host'))).toBe('Another Solus host answers at https://solus.example.com.')
  })

  test('a Funnel address this host cannot reach is not called down: the reason names the hairpin', async () => {
    const result = await probeAppAddress(FUNNEL, { installationId: 'this-host', fetchImpl: failing(codeError('ECONNRESET')) })
    expect(result.reachable).toBe(false)
    expect(result.reason).toContain('cannot always reach its own Funnel address, so it can still work from outside')
  })
})
