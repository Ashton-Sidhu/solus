import { afterEach, describe, expect, test, mock, jest } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'

// Bun has no node:sqlite; this code reaches the database through the host's installation id (admission/auth.ts).
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { funnelAllowed, funnelPortError, serveError, serveMappingsToPort, serveOwnership, serveUrl, TailscaleServe, verifiedServeRoute } = await import('@solus/server/host/tailscale-serve')
const { isProxiedRequest, publicAddressNamedBy, setOwnMagicDnsName, couldBeForgedByWebPage, requestOrigin } = await import('@solus/server/transport/web-page-requests')
const { publicOrigin } = await import('@solus/server/transport/mcp-oauth')
const settings = await import('@solus/server/host/settings')

const mapping = (port: number, target: string) => JSON.stringify({ Web: { [`box.tail.ts.net:${port}`]: { Handlers: { '/': { Proxy: target } } } } })
const status = { BackendState: 'Running', Self: { DNSName: 'box.tail.ts.net.', CapMap: { https: [] } } }

describe('Tailscale Serve ownership', () => {
  test('recognizes only its exact root target', () => {
    expect(serveOwnership('null', 443, 3000)).toBe('none')
    expect(serveOwnership(mapping(443, 'http://127.0.0.1:3000'), 443, 3000)).toBe('ours')
    expect(serveOwnership(mapping(443, 'http://127.0.0.1:4000'), 443, 3000)).toBe('other')
    expect(serveOwnership(JSON.stringify({ TCP: { 443: { TCPForward: '127.0.0.1:3000' } } }), 443, 3000)).toBe('other')
    expect(serveMappingsToPort(mapping(8443, 'http://127.0.0.1:3000'), 3000)).toEqual([8443])
    expect(serveMappingsToPort(JSON.stringify({ Services: { app: { Web: { 'box.tail.ts.net:8443': { Handlers: { '/app': { Proxy: '3000' } } } } } } }), 3000)).toEqual([8443])
    expect(serveUrl('box.tail.ts.net.', 443)).toBe('https://box.tail.ts.net')
    const active = { enabled: true, funnel: false, port: 443, state: 'active' as const, url: 'https://box.tail.ts.net', error: null }
    expect(verifiedServeRoute(active, false)).toBeNull()
    expect(verifiedServeRoute(active, true)).toEqual({ kind: 'tailnet', url: active.url })
  })

  test('enables, probes and removes only a mapping this process made', async () => {
    let current = 'null'
    const calls: string[][] = []
    const command = mock(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'serve' && args[1] === 'status') return current
      if (args.includes('off')) current = 'null'
      else current = mapping(443, 'http://127.0.0.1:3000')
      return ''
    })
    const serve = new TailscaleServe(command, async () => new Response(JSON.stringify({ installationId: 'this-host' })), async () => status)
    expect((await serve.enable(443, 3000)).state).toBe('active')
    expect(await serve.probe('https://box.tail.ts.net', 'this-host')).toBe(true)
    expect(await serve.probe('https://box.tail.ts.net', 'another-host')).toBe(false)
    await serve.shutdown(3000)
    expect(calls.some((args) => args.includes('off'))).toBe(true)
  })

  test('refuses another root mapping and does not remove it', async () => {
    const command = mock(async () => mapping(443, 'http://127.0.0.1:4000'))
    const serve = new TailscaleServe(command, fetch, async () => status, async () => true)
    expect(serve.enable(443, 3000)).rejects.toThrow('Another service')
    await serve.shutdown(3000)
    expect(command).toHaveBeenCalledTimes(1)
  })

  test('repairs a dead loopback root and clears policy mappings', async () => {
    let current = mapping(443, 'http://localhost:4000')
    const calls: string[][] = []
    const command = async (args: string[]) => {
      calls.push(args)
      if (args[1] === 'status') return current
      if (args.includes('off')) current = 'null'
      else current = mapping(443, 'http://127.0.0.1:3000')
      return ''
    }
    const serve = new TailscaleServe(command, fetch, async () => status, async () => false)
    expect((await serve.enable(443, 3000)).state).toBe('active')
    await serve.removeMappingsToPort(3000)
    expect(calls.some((args) => args.includes('off'))).toBe(true)
  })

  test('refuses a policy boot when an own mapping stays', async () => {
    const command = async () => mapping(443, 'http://127.0.0.1:3000')
    const serve = new TailscaleServe(command, fetch, async () => status)
    expect(serve.removeMappingsToPort(3000)).rejects.toThrow('still publishes this host')
  })

  test('a missing CLI means no mapping for policy boot', async () => {
    const serve = new TailscaleServe(async () => { throw new Error('Install the Tailscale CLI, then try again.') })
    await expect(serve.removeMappingsToPort(3000)).resolves.toBeUndefined()
  })

  test('maps safe errors', () => {
    expect(serveError('permission denied', 'linux')).toContain('sudo tailscale set --operator=$USER')
    expect(serveError('HTTPS certificates disabled')).toContain('login.tailscale.com/admin/dns')
    expect(serveError('not logged in')).toContain('Sign in')
    expect(serveError('tailscaled.service not running')).toContain('Start Tailscale')
    expect(serveError("doesn't support connecting to remote destinations")).toContain('cannot proxy')
  })

  test('checks the mapping again after 30 seconds', async () => {
    jest.useFakeTimers()
    try {
      let reads = 0
      const command = async (args: string[]) => {
        if (args[1] === 'status') { reads++; return mapping(443, 'http://127.0.0.1:3000') }
        return ''
      }
      const serve = new TailscaleServe(command, fetch, async () => status)
      serve.startRepair(443, 3000)
      jest.advanceTimersByTime(30_000)
      await Promise.resolve()
      await Promise.resolve()
      expect(reads).toBeGreaterThan(0)
      serve.stopRepair()
    } finally { jest.useRealTimers() }
  })
})

describe('Serve request trust', () => {
  test('MagicDNS is accepted but proxy traffic loses loopback trust', () => {
    setOwnMagicDnsName('box.tail.ts.net.')
    expect(couldBeForgedByWebPage({ host: 'box.tail.ts.net' })).toBe(false)
    expect(isProxiedRequest('127.0.0.1', { host: 'box.tail.ts.net' })).toBe(true)
    expect(isProxiedRequest('127.0.0.1', { host: 'localhost', 'x-forwarded-proto': 'https' })).toBe(true)
    expect(isProxiedRequest('100.80.1.2', { host: 'localhost', 'x-forwarded-proto': 'https' })).toBe(false)
    expect(isProxiedRequest('127.0.0.1', { host: 'localhost' })).toBe(false)
    expect(requestOrigin('127.0.0.1', { host: 'localhost:3000', 'x-forwarded-host': 'box.tail.ts.net', 'x-forwarded-proto': 'https' })).toBe('https://box.tail.ts.net')
    expect(requestOrigin('100.80.1.2', { host: 'box.tail.ts.net:3000', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' })).toBe('http://box.tail.ts.net:3000')
    setOwnMagicDnsName(null)
  })
})

// WHY: Funnel puts this host's Serve address on the internet, so an outside app in
// the cloud reaches /mcp with no Solus account (plans/035 §0.8). It must use the
// same port and target as Serve, so the address does not change; it accepts only
// Funnel's ports; and turning it off must leave Serve, and every mapping Solus did
// not make, as they were.
describe('Tailscale Funnel', () => {
  const withFunnel = (raw: string, port: number) => JSON.stringify({ ...JSON.parse(raw), AllowFunnel: { [`box.tail.ts.net:${port}`]: true } })

  function tailscale(initial: string) {
    let current = initial
    const calls: string[][] = []
    const command = async (args: string[]) => {
      calls.push(args)
      if (args[1] === 'status') return current
      const port = Number(args.find((arg) => arg.startsWith('--https='))?.slice('--https='.length))
      if (args.includes('off')) current = 'null'
      else current = args[0] === 'funnel' ? withFunnel(mapping(port, args.at(-1)!), port) : mapping(port, args.at(-1)!)
      return ''
    }
    return { serve: new TailscaleServe(command, fetch, async () => status, async () => true), calls, changes: () => calls.filter((args) => args[1] !== 'status') }
  }

  test('reads Funnel only on the mapping to this host', async () => {
    expect(funnelAllowed(withFunnel(mapping(443, 'http://127.0.0.1:3000'), 443), 'box.tail.ts.net.', 443)).toBe(true)
    expect(funnelAllowed(mapping(443, 'http://127.0.0.1:3000'), 'box.tail.ts.net', 443)).toBe(false)
    expect((await tailscale(withFunnel(mapping(443, 'http://127.0.0.1:3000'), 443)).serve.status(true, 443, 3000)).funnel).toBe(true)
    // Another service's Funnel on the port is not this host's address.
    expect((await tailscale(withFunnel(mapping(443, 'http://127.0.0.1:4000'), 443)).serve.status(true, 443, 3000)).funnel).toBe(false)
  })

  test('turning it on runs tailscale funnel for the same HTTPS port and target as Serve', async () => {
    const { serve, changes } = tailscale(mapping(8443, 'http://127.0.0.1:3000'))
    const next = await serve.setFunnel(true, 8443, 3000)
    expect(changes()).toEqual([['funnel', '--bg', '--https=8443', 'http://127.0.0.1:3000']])
    expect(next).toMatchObject({ state: 'active', funnel: true, url: 'https://box.tail.ts.net:8443' })
  })

  test('turning it off removes only the Funnel: Serve stays on at the same address', async () => {
    const { serve, changes } = tailscale(withFunnel(mapping(443, 'http://127.0.0.1:3000'), 443))
    const next = await serve.setFunnel(false, 443, 3000)
    expect(changes()).toEqual([['serve', '--bg', '--https=443', 'http://127.0.0.1:3000']])
    expect(changes().some((args) => args.includes('off'))).toBe(false)
    expect(next).toMatchObject({ state: 'active', funnel: false, url: 'https://box.tail.ts.net' })
  })

  test('accepts only ports 443, 8443, and 10000', async () => {
    for (const port of [443, 8443, 10000]) expect(funnelPortError(port)).toBeNull()
    expect(funnelPortError(8080)).toContain('443, 8443, or 10000')
    const { serve, changes } = tailscale(mapping(8080, 'http://127.0.0.1:3000'))
    expect(serve.setFunnel(true, 8080, 3000)).rejects.toThrow('443, 8443, or 10000')
    expect(changes()).toEqual([])
  })

  test('never touches a mapping Solus did not make, and needs Serve on first', async () => {
    const other = tailscale(mapping(443, 'http://127.0.0.1:4000'))
    expect(other.serve.setFunnel(true, 443, 3000)).rejects.toThrow('Another service')
    expect(other.serve.setFunnel(false, 443, 3000)).rejects.toThrow('Another service')
    const none = tailscale('null')
    expect(none.serve.setFunnel(true, 443, 3000)).rejects.toThrow('Turn on Tailscale HTTPS')
    await Bun.sleep(0)
    expect([...other.changes(), ...none.changes()]).toEqual([])
  })

  test('a mapping Solus makes again keeps the Funnel the person chose, on a Funnel port only', async () => {
    const chosen = tailscale('null')
    expect((await chosen.serve.enable(443, 3000, true)).funnel).toBe(true)
    expect(chosen.changes()).toEqual([['funnel', '--bg', '--https=443', 'http://127.0.0.1:3000']])
    const otherPort = tailscale('null')
    expect((await otherPort.serve.enable(8080, 3000, true)).funnel).toBe(false)
    expect(otherPort.changes()).toEqual([['serve', '--bg', '--https=8080', 'http://127.0.0.1:3000']])
  })

  test("names the tailnet policy, Funnel's port rule, and the tailnet switch in Tailscale's own words", () => {
    expect(serveError('Funnel not available; "funnel" node attribute not set. See https://tailscale.com/s/no-funnel.')).toContain('tailnet policy does not allow Funnel')
    expect(serveError('port 8080 is not allowed for funnel; allowed ports are: 443, 8443, 10000')).toContain('443, 8443, or 10000')
    expect(serveError('Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/funnel?node=abc123\n')).toBe('Funnel is off for your tailnet. Turn it on at https://login.tailscale.com/f/funnel?node=abc123, then try again.')
    // An HTTPS refusal stays an HTTPS refusal.
    expect(serveError('HTTPS certificates disabled')).toContain('login.tailscale.com/admin/dns')
  })
})

// WHY: a request through a proxy reaches the host on loopback, or from a machine
// of the local network. It must never be read as a request from this machine,
// which acts as the owner without a credential (plans/035 §0.8).
describe('proxied requests', () => {
  afterEach(() => { settings.setHostConfig({ publicAddress: '' }) })

  test("Tailscale Funnel's header marks a request from any address", () => {
    expect(isProxiedRequest('127.0.0.1', { host: 'localhost:3000', 'tailscale-funnel-request': '?1' })).toBe(true)
    expect(isProxiedRequest('192.168.1.9', { host: 'localhost:3000', 'tailscale-funnel-request': '?1' })).toBe(true)
  })

  test("the person's ingress is proxied by its Host alone, with no forwarded headers, from loopback or the local network", () => {
    expect(isProxiedRequest('127.0.0.1', { host: 'solus.example.com' })).toBe(false)
    settings.setHostConfig({ publicAddress: 'https://solus.example.com' })
    expect(isProxiedRequest('127.0.0.1', { host: 'solus.example.com' })).toBe(true)
    expect(isProxiedRequest('::1', { host: 'SOLUS.EXAMPLE.COM:443' })).toBe(true)
    expect(isProxiedRequest('192.168.1.9', { host: 'solus.example.com' })).toBe(true)
    expect(isProxiedRequest('127.0.0.1', { host: '127.0.0.1:3000', 'x-forwarded-host': 'solus.example.com' })).toBe(true)
    // A request to this machine by its own name is still local.
    expect(isProxiedRequest('127.0.0.1', { host: 'localhost:3000' })).toBe(false)
    expect(isProxiedRequest('127.0.0.1', { host: 'solus.example.com.evil.test' })).toBe(false)
  })

  test("the OAuth metadata names the ingress's https origin, even with no X-Forwarded-Proto", () => {
    settings.setHostConfig({ publicAddress: 'https://solus.example.com' })
    expect(publicAddressNamedBy({ host: 'solus.example.com' })).toBe('https://solus.example.com')
    expect(publicOrigin(new Request('http://solus.example.com/.well-known/oauth-protected-resource/mcp'))).toBe('https://solus.example.com')
    expect(publicOrigin(new Request('http://127.0.0.1:3000/mcp', { headers: { 'x-forwarded-host': 'solus.example.com' } }))).toBe('https://solus.example.com')
    // Tailscale Serve and Funnel name the public origin in their headers.
    expect(publicOrigin(new Request('http://127.0.0.1:3000/mcp', { headers: { host: 'box.tail.ts.net', 'x-forwarded-host': 'box.tail.ts.net', 'x-forwarded-proto': 'https' } }))).toBe('https://box.tail.ts.net')
  })
})
