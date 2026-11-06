import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { flushLogs, logFilePath } from '@solus/server/logger'
import { registerRemoteMachinesHandlers, type RemoteMachinesDeps } from '@solus/server/transport/handlers/remote-machines-handlers'
import { SolusServer, type HandlerCtx } from '@solus/server/transport/server'
import type { ForwardedHost } from '@solus/contracts/remote-machines'

// WHY: docs/plans/ssh-forward-password.md. A password reaches the host over RPC. It must
// reach every SSH step for the machine, and it must never reach a log: a dev build
// logs the arguments of a call.

const SECRET = 'correct-horse-battery-staple'
const owner: HandlerCtx = { clientId: 'ws:1', deviceId: 'device-1', principal: { kind: 'owner', via: 'local', expiresAt: null, deviceId: 'device-1', deviceLabel: 'Mac' } } as HandlerCtx

const forwarded: ForwardedHost = {
  installationId: 'install-box',
  label: 'box',
  sshTarget: 'ada@box',
  route: { kind: 'forwarded', url: 'http://127.0.0.1:50000', viaHostId: 'self' },
  identityKey: 'key',
  state: 'open',
  startedBySolus: true,
  isLinked: false,
}

function harness() {
  const added: Array<{ authSecret?: string }> = []
  const unlocked: Array<[string, string]> = []
  const provisions: Array<{ authSecret?: string }> = []
  const uninstalls: Array<string | undefined> = []
  const deps = {
    provisioner: {
      add: async (request: { authSecret?: string; link?: object }) => {
        provisions.push(request)
        return { status: 'ready', host: { target: { destination: 'ada@box' }, os: 'linux', label: 'box', installationId: 'install-box', remotePort: 3000, startedBySolus: true, session: { sessionToken: 'token', identityKey: 'key' } } }
      },
      uninstallService: async (_target: object, _os: string, authSecret?: string) => { uninstalls.push(authSecret) },
    },
    forwardedHosts: {
      add: async (host: { authSecret?: string }) => { added.push(host); return forwarded },
      list: () => [forwarded],
      unlock: async (installationId: string, authSecret: string) => { unlocked.push([installationId, authSecret]); return forwarded },
      record: () => ({ target: { destination: 'ada@box' }, authSecret: SECRET, os: 'linux', startedBySolus: true, label: 'box' }),
      remove: () => true,
      markLinked: () => {},
    },
    ssh: { resolvesToThisMachine: async () => false },
    wslProvisioner: {},
    listWslDistros: async () => ({ status: 'unavailable', message: '' }),
    broadcast: () => {},
  } as unknown as RemoteMachinesDeps
  const server = new SolusServer()
  registerRemoteMachinesHandlers(server, deps)
  return { server, added, unlocked, provisions, uninstalls }
}

describe('a password over RPC', () => {
  test('an add without a link keeps the password for its forward', async () => {
    const { server, added } = harness()
    const result = await server.handle('hostsAddOverSsh', [{ sshTarget: 'ada@box', authSecret: SECRET, requestId: 'r1' }], owner)
    expect(result.status).toBe('forwarded')
    expect(added[0]!.authSecret).toBe(SECRET)
  })

  test('a linked add uses the password once and holds no forward', async () => {
    const { server, added } = harness()
    await server.handle('hostsAddOverSsh', [{ sshTarget: 'ada@box', authSecret: SECRET, link: { ticket: 't', directoryUrl: 'https://app.solus.sh' }, requestId: 'r2' }], owner)
    expect(added).toHaveLength(0)
  })

  test('unlock gives the forward its password', async () => {
    const { server, unlocked } = harness()
    await server.handle('hostsUnlockForwarded', [{ installationId: 'install-box', authSecret: SECRET }], owner)
    expect(unlocked).toEqual([['install-box', SECRET]])
  })

  test('a caller with no device cannot unlock', async () => {
    const { server } = harness()
    const noDevice = { ...owner, deviceId: undefined } as HandlerCtx
    await expect(server.handle('hostsUnlockForwarded', [{ installationId: 'install-box', authSecret: SECRET }], noDevice)).rejects.toThrow('authenticated device')
  })

  test('linking and stopping Solus there sign in with the password the forward holds', async () => {
    const { server, provisions, uninstalls } = harness()
    await server.handle('hostsLinkForwarded', [{ installationId: 'install-box', link: { ticket: 't', directoryUrl: 'https://app.solus.sh' } }], owner)
    expect(provisions[0]!.authSecret).toBe(SECRET)
    await server.handle('hostsRemoveForwarded', [{ installationId: 'install-box', stopRemote: true }], owner)
    expect(uninstalls).toEqual([SECRET])
  })

  test('never reaches the log', async () => {
    const { server } = harness()
    await server.handle('hostsAddOverSsh', [{ sshTarget: 'ada@box', authSecret: SECRET, requestId: 'r3' }], owner)
    await server.handle('hostsUnlockForwarded', [{ installationId: 'install-box', authSecret: SECRET }], owner)
    await server.handle('hostsListForwarded', [], owner)
    flushLogs()
    const log = readFileSync(logFilePath(), 'utf8')
    // The list call has no secret and is logged, so this reads a log the test really wrote.
    expect(log).toContain('rpc_method_invoked')
    expect(log).not.toContain(SECRET)
  })
})
