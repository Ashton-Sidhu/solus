import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientFrameSchema } from '@solus/contracts/host-socket'
import { runHostCommand } from '../../apps/cli/src/lib/hosts'
import { desktopRefusal } from '../../apps/cli/src/lib/desktop-commands'

const folders: string[] = []
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }) })
function harness(answer?: (method: string, args: unknown[]) => unknown) {
  const folder = mkdtempSync(join(tmpdir(), 'solus-cli-hosts-'))
  folders.push(folder)
  const calls: Array<{ method: string; args: unknown[] }> = []
  const host = { id: 'windows', installationId: 'windows', label: 'Windows', routes: [], lastConnected: 1 }
  const remote = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response('Not found', { status: 404 }) },
    websocket: {
      message(socket, text) {
        const frame = clientFrameSchema.parse(JSON.parse(String(text)))
        if (frame.t === 'hello') socket.send(JSON.stringify({ t: 'welcome', epoch: 'test', seq: 0, recovered: false }))
        else if (frame.t === 'rpc') {
          calls.push({ method: frame.method, args: frame.args })
          const result = answer?.(frame.method, frame.args) ?? (frame.method === 'hostsListPaired' ? { hosts: [host], forgotten: [] } : frame.method === 'hostsForget' ? { removed: true } : host)
          socket.send(JSON.stringify({ t: 'result', id: frame.id, result }))
        }
      },
    },
  })
  writeFileSync(join(folder, 'server.lock'), JSON.stringify({ pid: process.pid, port: remote.port, host: '127.0.0.1', startedAt: Date.now() }))
  return { folder, calls, remote }
}

describe('the host CLI uses the running server', () => {
  test('pair, list, and remove use RPC without opening a second database', async () => {
    const h = harness()
    const output: string[] = []
    const log = (line: string) => output.push(line)
    try {
      const file = join(h.folder, 'pair-code')
      writeFileSync(file, '123456\n')
      await runHostCommand(['pair', 'http://10.0.0.2:3000', '--code-file', file, '--data-dir', h.folder], log)
      await runHostCommand(['list', '--json', '--data-dir', h.folder], log)
      await runHostCommand(['remove', 'windows', '--data-dir', h.folder], log)
      expect(h.calls.map((call) => call.method)).toEqual(['hostsPair', 'hostsListPaired', 'hostsForget'])
      expect(h.calls[0]?.args).toEqual([{ url: 'http://10.0.0.2:3000', code: '123456' }])
      expect(output.join('\n')).not.toContain('123456')
      expect(output[0]).toContain('Paired with Windows')
      expect(desktopRefusal('host')).toBeNull()
    } finally { await h.remote.stop(true) }
  })
  test('conflicting code inputs and mismatched links send no request', async () => {
    const h = harness()
    try {
      const end = ['--data-dir', h.folder]
      await expect(runHostCommand(['pair', 'http://10.0.0.2:3000', '--code', '123', '--code-file', 'unused', ...end], () => {})).rejects.toThrow('Usage')
      await expect(runHostCommand(['pair', 'http://10.0.0.2:3000', '--code', 'http://other:3000/pair#token=secret', ...end], () => {})).rejects.toThrow('different server')
      expect(h.calls).toEqual([])
    } finally { await h.remote.stop(true) }
  })

  // docs/ssh-machines.md, "Identity file": a cloud VM's key is a path on this host,
  // and a key that SSH refuses for its permissions is fixed only when the person asks.
  test('add-ssh sends the key path, and fixes a readable key only with --fix-key-permissions', async () => {
    const forwarded = { installationId: 'ec2', label: 'ec2', sshTarget: 'ubuntu@3.91.20.4', route: { kind: 'forwarded', url: 'http://127.0.0.1:50000', viaHostId: 'self' }, identityKey: 'key', state: 'open', startedBySolus: true, isLinked: false }
    let isKeyFixed = false
    const h = harness((method, args) => {
      if (method !== 'hostsAddOverSsh') return undefined
      // The fake host fixes the key when the request asks for it, as the real one does.
      const [request] = args as [{ fixIdentityFilePermissions?: boolean }]
      isKeyFixed ||= request.fixIdentityFilePermissions === true
      return !isKeyFixed ? { status: 'key-permissions', identityFile: '~/.ssh/aws.pem', message: 'Other users can read ~/.ssh/aws.pem.' } : { status: 'forwarded', host: forwarded, sessionToken: 't' }
    })
    const output: string[] = []
    try {
      const end = ['--data-dir', h.folder]
      await runHostCommand(['add-ssh', 'ubuntu@3.91.20.4', '--identity-file', '~/.ssh/aws.pem', ...end], (line) => output.push(line))
      expect(h.calls.map((call) => call.method)).toEqual(['hostsAddOverSsh'])
      expect(h.calls[0]?.args[0]).toMatchObject({ sshTarget: 'ubuntu@3.91.20.4', identityFile: '~/.ssh/aws.pem' })
      expect(output[0]).toContain('--fix-key-permissions')
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
      await runHostCommand(['add-ssh', 'ubuntu@3.91.20.4', '--identity-file', '~/.ssh/aws.pem', '--fix-key-permissions', ...end], (line) => output.push(line))
      expect(h.calls.map((call) => call.method)).toEqual(['hostsAddOverSsh', 'hostsAddOverSsh'])
      expect(h.calls[1]?.args[0]).toMatchObject({ identityFile: '~/.ssh/aws.pem', fixIdentityFilePermissions: true })
      expect(output.at(-1)).toContain('Added ec2')
    } finally {
      process.exitCode = 0
      await h.remote.stop(true)
    }
  })
})
