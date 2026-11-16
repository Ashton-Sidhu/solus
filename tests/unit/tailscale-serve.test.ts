import { describe, expect, test, mock, jest } from 'bun:test'
import { serveError, serveMappingsToPort, serveOwnership, serveUrl, TailscaleServe, verifiedServeRoute } from '@solus/server/host/tailscale-serve'
import { isServeRequest, setOwnMagicDnsName, couldBeForgedByWebPage, requestOrigin } from '@solus/server/transport/web-page-requests'

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
    const active = { enabled: true, port: 443, state: 'active' as const, url: 'https://box.tail.ts.net', error: null }
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
    expect(isServeRequest('127.0.0.1', { host: 'box.tail.ts.net' })).toBe(true)
    expect(isServeRequest('127.0.0.1', { host: 'localhost', 'x-forwarded-proto': 'https' })).toBe(true)
    expect(isServeRequest('100.80.1.2', { host: 'localhost', 'x-forwarded-proto': 'https' })).toBe(false)
    expect(isServeRequest('127.0.0.1', { host: 'localhost' })).toBe(false)
    expect(requestOrigin('127.0.0.1', { host: 'localhost:3000', 'x-forwarded-host': 'box.tail.ts.net', 'x-forwarded-proto': 'https' })).toBe('https://box.tail.ts.net')
    expect(requestOrigin('100.80.1.2', { host: 'box.tail.ts.net:3000', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' })).toBe('http://box.tail.ts.net:3000')
    setOwnMagicDnsName(null)
  })
})
