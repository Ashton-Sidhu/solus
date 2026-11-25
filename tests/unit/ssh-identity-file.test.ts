import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkIdentityFile, fixIdentityFilePermissions } from '@solus/server/remote-machines/identity-file'
import { registerRemoteMachinesHandlers, type RemoteMachinesDeps } from '@solus/server/transport/handlers/remote-machines-handlers'
import { SolusServer, type HandlerCtx } from '@solus/server/transport/server'

// WHY: docs/ssh-machines.md, "Identity file". A key downloaded from a cloud console
// (an AWS .pem) is often readable by other users, and ssh then refuses it with a
// message people do not read. Solus checks the key on the host before ssh runs, says
// what is wrong in plain words, and offers one fix that changes only the owner's file.

const folder = mkdtempSync(join(tmpdir(), 'solus-identity-file-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

function key(name: string, mode: number): string {
  const path = join(folder, name)
  writeFileSync(path, 'not a real key')
  chmodSync(path, mode)
  return path
}

describe('the identity file of an SSH add', () => {
  test('a key only its owner reads is ready; a missing one and a readable one say why', () => {
    expect(checkIdentityFile(key('ok.pem', 0o600), 'Mac mini', 'darwin')).toEqual({ status: 'ok' })
    expect(checkIdentityFile(join(folder, 'none.pem'), 'Mac mini', 'darwin')).toMatchObject({ status: 'missing', message: expect.stringContaining('No file at') })
    expect(checkIdentityFile(key('open.pem', 0o644), 'Mac mini', 'darwin')).toMatchObject({ status: 'too-open', message: expect.stringContaining('Other users on Mac mini') })
    // Windows OpenSSH reads ACLs, not mode bits.
    expect(checkIdentityFile(key('open-win.pem', 0o644), 'PC', 'win32')).toEqual({ status: 'ok' })
  })

  test('Fix permissions lets only the owner read the key, and never changes another user\'s file', () => {
    const path = key('fix.pem', 0o644)
    fixIdentityFilePermissions(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const other = key('other.pem', 0o644)
    expect(() => fixIdentityFilePermissions(other, statSync(other).uid + 1)).toThrow('belongs to another user')
    expect(statSync(other).mode & 0o777).toBe(0o644)
  })
})

describe('an SSH add that names a readable key', () => {
  test('asks to fix the key and sends nothing over SSH; the same add with Fix permissions fixes it, then adds', async () => {
    const provisions: object[] = []
    const deps = {
      provisioner: { add: async (request: object) => { provisions.push(request); return { status: 'needs-auth', message: 'stop here' } } },
      forwardedHosts: {},
      ssh: { resolvesToThisMachine: async () => false },
      wslProvisioner: {},
      listWslDistros: async () => ({ status: 'unavailable', message: '' }),
      hostName: () => 'Mac mini',
      broadcast: () => {},
    } as unknown as RemoteMachinesDeps
    const server = new SolusServer()
    registerRemoteMachinesHandlers(server, deps)
    const owner = { clientId: 'ws:1', deviceId: 'device-1', principal: { kind: 'owner', via: 'local', expiresAt: null, deviceId: 'device-1', deviceLabel: 'Mac' } } as HandlerCtx
    const path = key('aws.pem', 0o644)
    const result = await server.handle('hostsAddOverSsh', [{ sshTarget: 'ubuntu@3.91.20.4', identityFile: path, requestId: 'r1' }], owner)
    expect(result).toMatchObject({ status: 'key-permissions', identityFile: path })
    expect(provisions).toEqual([])
    const again = await server.handle('hostsAddOverSsh', [{ sshTarget: 'ubuntu@3.91.20.4', identityFile: path, fixIdentityFilePermissions: true, requestId: 'r2' }], owner)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(provisions).toHaveLength(1)
    expect(again).toMatchObject({ status: 'needs-auth' })
  })
})
