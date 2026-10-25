import { beforeEach, describe, expect, test } from 'bun:test'
import type { SshClient, SshForward, SshTarget } from '@solus/server/platform/ssh'
import { ForwardedHosts, type NewForward } from '@solus/server/remote-machines/forwarded-hosts'
import type { ForwardedHost } from '@solus/contracts/remote-machines'

// WHY: docs/plans/host-routes.md D7 and D9. A host added without an account is
// reached through an `ssh -L` forward this host holds. The forward must open again
// after it stops, keep its local port so a saved route stays valid, name this host
// as the only one that can dial it, and keep retrying (but no faster than once a
// minute) so a laptop that comes back gets its fast route back.

const SELF = 'install-self'
const KEY = 'rwYrck6nBUw4mf9XOsblvbvv90Mz16mQW65CFiARkXM'

class FakeForward {
  closed = false
  private finish: (code: number | null) => void = () => {}
  readonly exited = new Promise<number | null>((resolve) => { this.finish = resolve })
  constructor(readonly localPort: number, readonly remotePort: number) {}
  close(): void { this.closed = true; this.finish(0) }
  drop(): void { this.finish(255) }
}

function harness(options: { failOpens?: number } = {}) {
  const opened: Array<{ forward: FakeForward; preferred: number | undefined }> = []
  let failures = options.failOpens ?? 0
  let nextPort = 50_000
  const timers: Array<{ run: () => void; ms: number }> = []
  const changes: ForwardedHost[][] = []
  const ssh = {
    forward: async (_target: SshTarget, remotePort: number, _ready?: string, preferredLocalPort?: number) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('ssh: connect to host box port 22: Connection refused')
      }
      const forward = new FakeForward(preferredLocalPort ?? nextPort++, remotePort)
      opened.push({ forward, preferred: preferredLocalPort })
      return forward as unknown as SshForward
    },
  } as unknown as SshClient
  const hosts = new ForwardedHosts({
    ssh,
    selfInstallationId: () => SELF,
    remotePort: async () => 3000,
    onChange: (list) => changes.push(list),
    setTimeoutFn: ((run: () => void, ms: number) => { timers.push({ run, ms }); return timers.length }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
  })
  const runTimers = async () => {
    const due = timers.splice(0)
    for (const timer of due) timer.run()
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }
  return { hosts, opened, timers, changes, runTimers, setFailures: (count: number) => { failures = count } }
}

const BOX: NewForward = {
  installationId: 'install-box',
  label: 'box',
  target: { destination: 'ada@box' },
  os: 'linux',
  remotePort: 3000,
  identityKey: KEY,
  sessionToken: 'token-box',
  startedBySolus: true,
}

beforeEach(() => {
  // The records are one secret in the test's data directory: start each test empty.
  const { hosts } = harness()
  for (const host of hosts.list()) hosts.remove(host.installationId)
})

describe('a forwarded host', () => {
  test('is a loopback route only this host can dial, with its session for host-to-host dials', async () => {
    const { hosts } = harness()
    const added = await hosts.add(BOX)
    expect(added.route).toEqual({ kind: 'forwarded', url: 'http://127.0.0.1:50000', viaHostId: SELF, source: 'ssh' })
    expect(added.state).toBe('open')
    expect(hosts.credential('install-box')).toBe('token-box')
    expect(hosts.credential('install-other')).toBeNull()
  })

  test('opens again on the same local port after the SSH connection drops', async () => {
    const { hosts, opened, runTimers } = harness()
    await hosts.add(BOX)
    opened[0]!.forward.drop()
    await Promise.resolve()
    expect(hosts.list()[0]!.state).toBe('reconnecting')
    await runTimers()
    expect(opened).toHaveLength(2)
    expect(opened[1]!.preferred).toBe(50_000)
    expect(hosts.list()[0]!.state).toBe('open')
  })

  test('keeps trying with backoff, no slower than once a minute, and says it failed once it waits that long', async () => {
    const { hosts, opened, timers, runTimers, setFailures } = harness()
    await hosts.add(BOX)
    setFailures(100)
    opened[0]!.forward.drop()
    await Promise.resolve()
    const waits: number[] = []
    for (let i = 0; i < 9; i += 1) {
      waits.push(timers[0]!.ms)
      await runTimers()
    }
    expect(waits.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(Math.max(...waits)).toBe(60_000)
    expect(hosts.list()[0]).toMatchObject({ state: 'failed', error: 'ssh: connect to host box port 22: Connection refused' })
  })

  test('is opened again at the next start, from what was saved', async () => {
    await harness().hosts.add(BOX)
    const restarted = harness()
    restarted.hosts.start()
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(restarted.opened).toHaveLength(1)
    expect(restarted.opened[0]!.preferred).toBe(50_000)
  })

  test('once linked too, it stays as a route and says so (D9)', async () => {
    const { hosts } = harness()
    await hosts.add(BOX)
    hosts.markLinked('install-box')
    expect(hosts.list()[0]!.isLinked).toBe(true)
  })

  test('removing it closes the forward and forgets its session', async () => {
    const { hosts, opened } = harness()
    await hosts.add(BOX)
    expect(hosts.remove('install-box')).toBe(true)
    expect(opened[0]!.forward.closed).toBe(true)
    expect(hosts.list()).toEqual([])
    expect(hosts.credential('install-box')).toBeNull()
  })

  test('an add whose forward never opens fails, so the person sees why', async () => {
    const { hosts } = harness({ failOpens: 1 })
    await expect(hosts.add(BOX)).rejects.toThrow('Connection refused')
  })
})
