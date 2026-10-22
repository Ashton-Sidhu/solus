import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HostRegistrar } from '@solus/server/host/host-registration'
import { UplinkLinkManager, type UplinkConnectorHandle } from '@solus/server/transport/uplink/link'
import type { EnrollHostResponse, HostLinkResponse } from '@solus/contracts/uplink'

// A host checks its registration with Solus cloud at boot (`HostRegistrar.resume`).
// Before, one failed check (no network yet, or a clock that the network has not set
// yet) was the end: nothing asked again until the next restart. Now the boot check is
// tried again with a growing wait until Solus cloud answers, and the link follows the
// answer. A refusal lasts, so it is not asked again; shutdown ends the retries.

const DIRECTORY = 'https://app.example.test'
const HOST_ID = 'abcdefghijklmnop'
const TUNNEL = { hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 }

/** How the account plane's token endpoint answers: as usual, not at all, with a clock refusal, or with a refusal of the key. */
type TokenEndpoint = 'up' | 'down' | 'clock' | 'refused'

function fakeControlPlane() {
  const plane = { tokenEndpoint: 'up' as TokenEndpoint, linked: true, linkReads: 0 }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === `${DIRECTORY}/api/auth/oauth2/token`) {
      switch (plane.tokenEndpoint) {
        case 'down': throw new TypeError('fetch failed')
        case 'clock': return Response.json({ error: 'invalid_client', error_description: 'client assertion has expired' }, { status: 400 })
        case 'refused': return Response.json({ error: 'invalid_client', error_description: 'unknown client' }, { status: 401 })
        case 'up': return Response.json({ access_token: 'control', expires_in: 1 })
      }
    }
    if (url.endsWith('/v1/hosts/enroll')) {
      const enrolled: EnrollHostResponse = {
        registration: { hostId: HOST_ID, issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY, generation: 1 },
        oauthClient: { clientId: `host_${HOST_ID}` },
      }
      return Response.json(enrolled)
    }
    if (url.endsWith('/link') && method === 'GET') {
      plane.linkReads += 1
      const answer: HostLinkResponse = { hostId: HOST_ID, generation: 1, desired: plane.linked ? 'linked' : 'unlinked', tunnel: plane.linked ? TUNNEL : null }
      return Response.json(answer)
    }
    if (url.endsWith('/link') && method === 'POST') return Response.json({ tunnel: TUNNEL, connectorToken: 'connector-token-1' })
    return new Response('not found', { status: 404 })
  }
  return { plane, fetchImpl }
}

/** A timer the test fires by hand: it records each wait the registrar asks for. */
function manualSchedule() {
  const waits: number[] = []
  let pending: { run: () => Promise<void>; isCancelled: boolean } | null = null
  return {
    waits,
    schedule: (run: () => Promise<void>, delayMs: number) => {
      waits.push(delayMs)
      const entry = { run, isCancelled: false }
      pending = entry
      return () => { entry.isCancelled = true }
    },
    /** Fires the waiting retry, as its timer would, and waits for it to finish. */
    async fire(): Promise<void> {
      const entry = pending
      pending = null
      if (entry && !entry.isCancelled) await entry.run()
    },
    get isWaiting(): boolean { return pending !== null && !pending.isCancelled },
  }
}

function hostOf(fetchImpl: typeof fetch, schedule: ReturnType<typeof manualSchedule>['schedule'], options: { connectorStartFails?: boolean } = {}) {
  const events: string[] = []
  const connector: UplinkConnectorHandle = {
    start() {
      events.push('start')
      if (options.connectorStartFails) throw new Error('cloudflared is missing')
    },
    async stop() { events.push('stop') },
  }
  let link: UplinkLinkManager | null = null
  const registrar = new HostRegistrar({
    installationId: () => 'install-1',
    hostLabel: () => 'Test host',
    os: () => 'macos',
    owner: () => null,
    fetchImpl,
    schedule,
    onRegistrationChanged: (registration) => link?.registrationChanged(registration),
  })
  link = new UplinkLinkManager({ registration: () => registrar.current(), controlToken: () => registrar.controlToken(), proxiedPort: () => 34118, connector, fetchImpl })
  const follows: Array<{ remote: HostLinkResponse | null; isRetrying: boolean }> = []
  /** What `boot-server.ts` does with the boot check. */
  const boot = () => registrar.resumeUntilAnswered(async (remote, isRetrying) => {
    follows.push({ remote, isRetrying })
    await link!.resume(remote, isRetrying)
  })
  return { registrar, link, events, follows, boot }
}

describe('the boot registration check is tried again', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir = ''
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-registration-retry-'))
    process.env.SOLUS_DATA_DIR = dataDir
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  /** A host registered and linked in an earlier run. */
  async function linkedBefore(fetchImpl: typeof fetch): Promise<void> {
    const before = hostOf(fetchImpl, manualSchedule().schedule)
    await before.registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    await before.link.link()
  }

  test('a boot without network asks again with a growing wait, capped at ten minutes, and the link follows the late answer', async () => {
    const { plane, fetchImpl } = fakeControlPlane()
    await linkedBefore(fetchImpl)
    plane.tokenEndpoint = 'down'
    const timer = manualSchedule()
    const host = hostOf(fetchImpl, timer.schedule)

    await host.boot()
    // The link starts at once from what it stored; the check waits to be asked again.
    expect(host.follows).toEqual([{ remote: null, isRetrying: true }])
    expect(host.events).toEqual(['start'])
    for (let i = 0; i < 6; i += 1) await timer.fire()
    expect(timer.waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
    expect(host.follows).toHaveLength(1)

    // Solus cloud says the link was turned off elsewhere while the host could not ask.
    plane.tokenEndpoint = 'up'
    plane.linked = false
    await timer.fire()
    expect(host.follows.at(-1)).toEqual({ remote: expect.objectContaining({ desired: 'unlinked' }), isRetrying: false })
    expect(timer.isWaiting).toBe(false)
    expect(host.events).toEqual(['start', 'stop'])
    expect(host.link.status()).toEqual({ linked: false })
    expect(host.registrar.current()).toMatchObject({ hostId: HOST_ID })
  })

  test('a clock the account plane refuses is asked again, and the registration is kept', async () => {
    // The account plane says `invalid_client` for an expired assertion. Before, the host
    // read that as a refused key and forgot its registration and key for a wrong clock.
    const { plane, fetchImpl } = fakeControlPlane()
    await linkedBefore(fetchImpl)
    plane.tokenEndpoint = 'clock'
    const timer = manualSchedule()
    const host = hostOf(fetchImpl, timer.schedule)

    await host.boot()
    expect(host.registrar.current()).toMatchObject({ hostId: HOST_ID })
    expect(host.registrar.needsRegistration()).toBe(false)
    expect(timer.waits).toEqual([30_000])

    plane.tokenEndpoint = 'up'
    await timer.fire()
    expect(host.follows.at(-1)).toEqual({ remote: expect.objectContaining({ desired: 'linked' }), isRetrying: false })
    expect(timer.isWaiting).toBe(false)
  })

  test('a registration Solus cloud refuses is not asked about again', async () => {
    const { plane, fetchImpl } = fakeControlPlane()
    await linkedBefore(fetchImpl)
    plane.tokenEndpoint = 'refused'
    const timer = manualSchedule()
    const host = hostOf(fetchImpl, timer.schedule)

    await host.boot()
    expect(host.registrar.current()).toBeNull()
    expect(host.follows).toEqual([{ remote: null, isRetrying: false }])
    expect(timer.waits).toEqual([])
    expect(existsSync(join(dataDir, 'host-link.json'))).toBe(false)
  })

  test('shutdown ends the retries: a timer that fires after it asks nothing', async () => {
    const { plane, fetchImpl } = fakeControlPlane()
    await linkedBefore(fetchImpl)
    plane.tokenEndpoint = 'down'
    const timer = manualSchedule()
    const host = hostOf(fetchImpl, timer.schedule)
    await host.boot()
    expect(timer.isWaiting).toBe(true)

    host.registrar.stopResuming()
    expect(timer.isWaiting).toBe(false)
    plane.tokenEndpoint = 'up'
    const reads = plane.linkReads
    await timer.fire()
    expect(plane.linkReads).toBe(reads)
    expect(host.follows).toHaveLength(1)
  })

  test('while the check is retried, the link status does not tell the user to restart Solus', async () => {
    const { plane, fetchImpl } = fakeControlPlane()
    await linkedBefore(fetchImpl)
    plane.tokenEndpoint = 'down'
    const host = hostOf(fetchImpl, manualSchedule().schedule, { connectorStartFails: true })
    await host.boot()
    const status = host.link.status()
    expect(status).toMatchObject({ linked: true, state: { observed: 'error' } })
    const error = status.linked && status.state.observed === 'error' ? status.state.error : ''
    expect(error).toContain('tries again')
    expect(error).not.toContain('Restart Solus')
  })
})
