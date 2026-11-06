import { describe, expect, test } from 'bun:test'
import type { UplinkStatus } from '@solus/contracts/uplink'
import { classifySelfTest, createHostSelfTest, probeAddress, type SelfTestFacts } from '../../packages/server/src/transport/uplink/self-test'

// `solus connect status` and the Access tab name real causes. A blocked port 7844 looks
// like a healthy machine, so the test must tell it apart, and must not blame it when
// the tunnel works (docs/host-connection-troubleshooting.md).

const LINKED: SelfTestFacts = {
  installationId: 'inst-1',
  registered: true,
  hostname: 'h-1.solus.sh',
  linkError: null,
  isTunnelTurnedOffByPolicy: false,
  connector: { isInstalled: true, isRunning: true, readyConnections: 4, protocol: 'auto' },
  listener: { expectedPort: 34118, boundPort: 34118, isAnswering: true },
  cloud: { kind: 'status', status: 200, installationId: null },
  endpoint: { kind: 'status', status: 200, installationId: 'inst-1' },
  isEdgeReachable: true,
  exitNode: null,
}
const test_ = (overrides: Partial<SelfTestFacts>) => classifySelfTest({ ...LINKED, ...overrides }, 1)
const resultsOf = (overrides: Partial<SelfTestFacts>) => Object.fromEntries(test_(overrides).stages.map((report) => [report.stage, report.result]))
const down = { connector: { ...LINKED.connector!, readyConnections: 0 }, endpoint: { kind: 'status', status: 530, installationId: null } } as const

describe('host self-test', () => {
  test('a healthy link has no problem and cannot speak for other devices', () => {
    const result = test_({})
    expect(result.reachable).toBe(true)
    expect(result.problem).toBeNull()
    expect(result.summary).toBe('Other devices can reach this machine through its tunnel.')
    // WHY: this test runs on the host. It proves nothing about another device's network.
    expect(result.stages[0]).toMatchObject({ stage: 'device', result: 'unknown' })
    expect(result.stages.slice(1).map((report) => report.result)).toEqual(['ok', 'ok', 'ok'])
  })

  test('names a blocked port 7844', () => {
    const result = test_({ ...down, isEdgeReachable: false })
    expect(result.problem).toMatchObject({ cause: 'edge-blocked', stage: 'tunnel' })
    expect(result.problem?.fix).toContain('7844')
    expect(result.reachable).toBe(false)
  })

  test('names the Tailscale exit node that a blocked port goes through', () => {
    const result = test_({ ...down, isEdgeReachable: false, exitNode: { name: 'fra-exit' } })
    expect(result.problem?.hint).toBe('Tailscale exit node "fra-exit" is on. Traffic to Cloudflare goes through it.')
    expect(result.problem?.fix).toContain('tailscale set --exit-node=')
  })

  test('a failed TCP test does not hide a real cause', () => {
    // WHY: the test is TCP only. With QUIC connections up, the port is not the cause.
    expect(test_({ endpoint: { kind: 'status', status: 530, installationId: null }, isEdgeReachable: false }).problem?.cause).toBe('no-connector')
    // WHY: a 502 came through a working tunnel.
    expect(test_({ ...down, endpoint: { kind: 'status', status: 502, installationId: null }, isEdgeReachable: false }).problem?.cause).toBe('origin-unreachable')
    expect(test_({ ...down, endpoint: { kind: 'dns-failed' }, isEdgeReachable: false }).problem?.cause).toBe('dns-failed')
  })

  test('a 502 proves the tunnel and fails the host', () => {
    expect(resultsOf({ endpoint: { kind: 'status', status: 502, installationId: null } })).toMatchObject({ tunnel: 'ok', host: 'failed' })
    expect(test_({ endpoint: { kind: 'status', status: 502, installationId: null }, listener: { ...LINKED.listener!, isAnswering: false } }).problem?.cause).toBe('listener-silent')
  })

  test('names each connector state', () => {
    expect(test_({ connector: { ...LINKED.connector!, isInstalled: false, isRunning: false } }).problem?.cause).toBe('cloudflared-missing')
    expect(test_({ connector: { ...LINKED.connector!, isRunning: false }, linkError: 'The tunnel credential is missing' }).problem).toMatchObject({ cause: 'connector-stopped', reason: 'The tunnel credential is missing' })
    expect(test_(down).problem?.cause).toBe('connector-connecting')
  })

  test('a port another program holds is a host problem, and the tunnel is unknown', () => {
    const facts = { ...down, listener: { expectedPort: 34118, boundPort: 0, isAnswering: null } }
    expect(test_(facts).problem?.cause).toBe('port-conflict')
    // WHY: a 530 proves nothing about the tunnel, so the failure past it must not mark it ok.
    expect(resultsOf(facts)).toMatchObject({ tunnel: 'unknown', host: 'failed' })
  })

  test('an answer from another server is not this host', () => {
    const result = test_({ endpoint: { kind: 'status', status: 200, installationId: 'someone-else' } })
    expect(result.problem?.cause).toBe('other-host-answered')
    expect(result.reachable).toBe(false)
  })

  test('the first failed stage is the problem, and the tunnel reason stays beside it', () => {
    const result = test_({ cloud: { kind: 'timeout' }, endpoint: { kind: 'timeout' }, isEdgeReachable: false, connector: { ...LINKED.connector!, readyConnections: 0 } })
    expect(result.problem).toMatchObject({ stage: 'cloud', cause: 'cloud-unreachable' })
    expect(result.problem?.hint).toContain('7844')
    expect(result.stages.find((report) => report.stage === 'tunnel')?.result).toBe('failed')
  })

  test('a host that cannot reach Solus Cloud can still be reachable', () => {
    const result = test_({ cloud: { kind: 'network-error' } })
    expect(result.reachable).toBe(true)
    expect(result.problem?.cause).toBe('cloud-unreachable')
    expect(result.summary).toContain('but it cannot reach Solus Cloud')
  })

  test('a host that is not linked has no failure: a direct host is a choice', () => {
    const result = test_({ hostname: null, connector: null, listener: null, endpoint: null, isEdgeReachable: null })
    expect(result.reachable).toBeNull()
    expect(result.problem).toBeNull()
    expect(result.stages.find((report) => report.stage === 'tunnel')?.result).toBe('unknown')
    expect(result.summary).toBe('This machine is not linked. Clients connect to it directly.')
  })

  test('a link Solus Cloud refused is named', () => {
    const result = test_({ hostname: null, connector: null, listener: null, endpoint: null, isEdgeReachable: null, linkError: 'Solus cloud refused the link' })
    expect(result.problem).toMatchObject({ cause: 'link-rejected', reason: 'Solus cloud refused the link' })
  })

  test('a policy that turns the tunnel off says so', () => {
    const result = test_({ hostname: null, connector: null, listener: null, endpoint: null, isEdgeReachable: null, isTunnelTurnedOffByPolicy: true })
    expect(result.summary).toContain('A policy turns the tunnel off')
  })

  test('a machine reached directly is not tested for a connector', () => {
    expect(test_({ connector: null, listener: null, isEdgeReachable: null }).problem).toBeNull()
    expect(test_({ connector: null, listener: null, isEdgeReachable: null, endpoint: { kind: 'status', status: 530, installationId: null } }).problem?.cause).toBe('no-connector')
  })

  test('says that UDP was not tested', () => {
    expect(test_({}).facts.find((fact) => fact.label === 'Port 7844')?.value).toBe('TCP open; UDP not tested')
  })
})

describe('probeAddress', () => {
  test('names a DNS failure from the cause of the error', async () => {
    const fetchImpl = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) }
    expect(await probeAddress(fetchImpl, 'https://x.test', 100)).toEqual({ kind: 'dns-failed' })
  })

  test('reads the installation of a Solus host', async () => {
    const fetchImpl = async () => Response.json({ ok: true, installationId: 'inst-1' })
    expect(await probeAddress(fetchImpl, 'https://x.test', 100)).toEqual({ kind: 'status', status: 200, installationId: 'inst-1' })
  })
})

describe('createHostSelfTest', () => {
  const linked: UplinkStatus = {
    registration: { registered: true, registration: { hostId: 'h1', issuer: 'https://app.test', jwksUrl: 'https://app.test/jwks', directoryUrl: 'https://app.test', generation: 1, apiUrl: 'https://api.test' }, owner: null },
    link: { linked: true, tunnel: { hostname: 'h-1.test', proxiedPort: 34118 }, state: { observed: 'online' } },
  }

  test('reads each address once, and a second request shares the running test', async () => {
    const urls: string[] = []
    const edge: string[] = []
    const run = createHostSelfTest({
      installationId: () => 'inst-1',
      status: () => linked,
      isReachedDirectly: () => false,
      isTunnelTurnedOffByPolicy: () => false,
      boundPort: () => 34118,
      connector: () => ({ isInstalled: true, isRunning: true, readyConnections: 2, protocol: 'auto' }),
      exitNode: async () => null,
      openTcp: async (host, port) => {
        edge.push(`${host}:${port}`)
        return true
      },
      fetchImpl: async (url) => {
        urls.push(String(url))
        return Response.json({ ok: true, installationId: 'inst-1' })
      },
      now: () => 9,
    })
    const [first, second] = await Promise.all([run(), run()])
    expect(first).toBe(second)
    expect(first.reachable).toBe(true)
    expect(urls.sort()).toEqual(['http://127.0.0.1:34118/health', 'https://app.test/.well-known/openid-configuration', 'https://h-1.test/health'])
    expect(edge.sort()).toEqual(['region1.v2.argotunnel.com:7844', 'region2.v2.argotunnel.com:7844'])
  })
})
