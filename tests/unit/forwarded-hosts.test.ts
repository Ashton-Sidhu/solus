import { beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { z } from 'zod'
import { dataDir } from '@solus/server/platform/paths'
import { secretStore } from '@solus/server/platform/secrets'
import type { SshClient, SshForward, SshTarget } from '@solus/server/platform/ssh'
import { ForwardedHosts, type NewForward } from '@solus/server/remote-machines/forwarded-hosts'
import { AuthNeeded } from '@solus/server/remote-machines/ssh-provisioner'
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

/** The machine takes this password and refuses everything else; absent, it takes the host's keys. */
function harness(options: { failOpens?: number; password?: string } = {}) {
  const opened: Array<{ forward: FakeForward; preferred: number | undefined; target: SshTarget; authSecret: string | undefined }> = []
  let failures = options.failOpens ?? 0
  let password = options.password
  const portChecks: Array<string | undefined> = []
  let nextPort = 50_000
  const timers: Array<{ run: () => void; ms: number }> = []
  const changes: ForwardedHost[][] = []
  const ssh = {
    forward: async (target: SshTarget, remotePort: number, _ready?: string, preferredLocalPort?: number, authSecret?: string) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('ssh: connect to host box port 22: Connection refused')
      }
      const forward = new FakeForward(preferredLocalPort ?? nextPort++, remotePort)
      opened.push({ forward, preferred: preferredLocalPort, target, authSecret })
      return forward as unknown as SshForward
    },
  } as unknown as SshClient
  const hosts = new ForwardedHosts({
    ssh,
    selfInstallationId: () => SELF,
    remotePort: async (_target, authSecret) => {
      portChecks.push(authSecret)
      if (password !== undefined && authSecret !== password) throw new AuthNeeded(authSecret ? 'ada@box refused that password or passphrase.' : 'ada@box refused the SSH keys this computer offered.')
      return 3000
    },
    onChange: (list) => changes.push(list),
    setTimeoutFn: ((run: () => void, ms: number) => { timers.push({ run, ms }); return timers.length }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
  })
  const runTimers = async () => {
    const due = timers.splice(0)
    for (const timer of due) timer.run()
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }
  return { hosts, opened, timers, changes, portChecks, runTimers, setFailures: (count: number) => { failures = count }, setPassword: (next: string) => { password = next } }
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

  test('reopens at the next start with the identity file it was added with, so an AWS key still signs in', async () => {
    await harness().hosts.add({ ...BOX, target: { destination: 'ec2-user@ec2.example.com', port: 2222, identityFile: '~/.ssh/aws.pem' } })
    const restarted = harness()
    restarted.hosts.start()
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(restarted.opened[0]!.target).toEqual({ destination: 'ec2-user@ec2.example.com', port: 2222, identityFile: '~/.ssh/aws.pem' })
    expect(restarted.hosts.record('install-box')!.target.identityFile).toBe('~/.ssh/aws.pem')
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

// WHY: docs/plans/ssh-forward-password.md. A machine that takes only a password must
// stay reachable while this process lives, and must ask the person again after a
// restart. A refused password counts against the account on the machine, so a refusal
// never retries, and the password is never saved.
describe('a forward with a password', () => {
  const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() }

  test('opens again after a drop with the same password, and no prompt', async () => {
    const { hosts, opened, runTimers } = harness({ password: 'hunter2' })
    await hosts.add({ ...BOX, authSecret: 'hunter2' })
    expect(opened[0]!.authSecret).toBe('hunter2')
    opened[0]!.forward.drop()
    await Promise.resolve()
    await runTimers()
    expect(opened).toHaveLength(2)
    expect(opened[1]!.authSecret).toBe('hunter2')
    expect(hosts.list()[0]!.state).toBe('open')
  })

  test('is not in what clients read, or in what is saved', async () => {
    const { hosts } = harness({ password: 'hunter2' })
    await hosts.add({ ...BOX, authSecret: 'hunter2' })
    expect(JSON.stringify(hosts.list())).not.toContain('hunter2')
    const saved = secretStore().loadJson('forwarded-hosts', join(dataDir(), 'forwarded-hosts.bin'), z.object({ hosts: z.array(z.object({}).loose()) }))
    expect(saved?.hosts).toHaveLength(1)
    expect(JSON.stringify(saved)).not.toContain('hunter2')
  })

  test('after a restart waits for the person, and does not retry', async () => {
    await harness({ password: 'hunter2' }).hosts.add({ ...BOX, authSecret: 'hunter2' })
    const restarted = harness({ password: 'hunter2' })
    restarted.hosts.start()
    await settle()
    expect(restarted.opened).toHaveLength(0)
    expect(restarted.timers).toHaveLength(0)
    const [host] = restarted.hosts.list()
    expect(host!.state).toBe('needs-auth')
    // Nothing was refused yet: the row asks, and shows no error.
    expect(host!.error).toBeUndefined()
    expect(restarted.changes.at(-1)![0]!.state).toBe('needs-auth')
  })

  test('opens when the person gives the password again, and keeps it for the next drop', async () => {
    await harness({ password: 'hunter2' }).hosts.add({ ...BOX, authSecret: 'hunter2' })
    const restarted = harness({ password: 'hunter2' })
    restarted.hosts.start()
    await settle()
    const unlocked = await restarted.hosts.unlock('install-box', 'hunter2')
    expect(unlocked.state).toBe('open')
    restarted.opened[0]!.forward.drop()
    await Promise.resolve()
    await restarted.runTimers()
    expect(restarted.opened[1]!.authSecret).toBe('hunter2')
  })

  test('a refused password stops the retries, leaves memory, and says so', async () => {
    await harness({ password: 'hunter2' }).hosts.add({ ...BOX, authSecret: 'hunter2' })
    const restarted = harness({ password: 'hunter2' })
    restarted.hosts.start()
    await settle()
    const refused = await restarted.hosts.unlock('install-box', 'wrong')
    expect(refused).toMatchObject({ state: 'needs-auth', error: 'ada@box refused that password or passphrase.' })
    expect(restarted.timers).toHaveLength(0)
    expect(restarted.portChecks.filter((secret) => secret === 'wrong')).toHaveLength(1)
    expect(restarted.hosts.record('install-box')!.authSecret).toBeUndefined()
  })

  test('a password changed on the machine moves an open forward to the prompt at its next open', async () => {
    const { hosts, opened, timers, runTimers, setPassword } = harness({ password: 'hunter2' })
    await hosts.add({ ...BOX, authSecret: 'hunter2' })
    setPassword('new-password')
    opened[0]!.forward.drop()
    await Promise.resolve()
    await runTimers()
    expect(hosts.list()[0]).toMatchObject({ state: 'needs-auth', error: 'ada@box refused that password or passphrase.' })
    expect(timers).toHaveLength(0)
    expect(opened).toHaveLength(1)
  })

  test('a machine that is offline stays a network failure, because the password is not the problem', async () => {
    const { hosts, opened, runTimers, setFailures } = harness({ password: 'hunter2' })
    await hosts.add({ ...BOX, authSecret: 'hunter2' })
    setFailures(1)
    opened[0]!.forward.drop()
    await Promise.resolve()
    await runTimers()
    expect(hosts.list()[0]!.state).toBe('reconnecting')
    await runTimers()
    expect(hosts.list()[0]!.state).toBe('open')
    expect(opened[1]!.authSecret).toBe('hunter2')
  })

  test('a second client sends nothing to the machine once the forward no longer waits', async () => {
    const { hosts, portChecks } = harness({ password: 'hunter2' })
    await hosts.add({ ...BOX, authSecret: 'hunter2' })
    const checks = portChecks.length
    expect((await hosts.unlock('install-box', 'stale')).state).toBe('open')
    expect(portChecks).toHaveLength(checks)
  })

  test('removing it forgets the password', async () => {
    const { hosts } = harness({ password: 'hunter2' })
    await hosts.add({ ...BOX, authSecret: 'hunter2' })
    hosts.remove('install-box')
    await hosts.add(BOX).catch(() => {})
    expect(hosts.record('install-box')!.authSecret).toBeUndefined()
  })

  test('unlocking a host this host does not forward to fails', async () => {
    await expect(harness().hosts.unlock('install-other', 'x')).rejects.toThrow('does not forward')
  })
})
