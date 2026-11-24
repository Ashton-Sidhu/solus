import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientFrameSchema } from '@solus/contracts/host-socket'
import { normalizeCheckCode } from '@solus/contracts/add-machine'
import { runHostCommand } from '../../apps/cli/src/lib/hosts'

const folders: string[] = []
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }) })

const open = [
  { requestId: 'r1', checkCode: 'K7QX-M2PA', deviceLabel: 'Windows', fromAddress: '10.0.0.7', requestedAt: Date.now(), expiresAt: Date.now() + 240_000 },
]

/** A running server that answers the approval methods and records each call. */
function harness() {
  const folder = mkdtempSync(join(tmpdir(), 'solus-cli-approvals-'))
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
          const result = frame.method === 'hostsPairApprovals' ? open : frame.method === 'hostsPairApprovalDecide' ? true : host
          socket.send(JSON.stringify({ t: 'result', id: frame.id, result }))
        }
      },
    },
  })
  writeFileSync(join(folder, 'server.lock'), JSON.stringify({ pid: process.pid, port: remote.port, host: '127.0.0.1', startedAt: Date.now() }))
  return { end: ['--data-dir', folder], calls, remote }
}

describe('the host CLI decides approval requests by check code', () => {
  test('a check code is accepted as a person types it', async () => {
    const h = harness()
    const output: string[] = []
    try {
      await runHostCommand(['approvals', ...h.end], (line) => output.push(line))
      await runHostCommand(['approve', 'k7qxm2pa', ...h.end], (line) => output.push(line))
      await runHostCommand(['deny', 'K7QX-M2PA', ...h.end], (line) => output.push(line))
      expect(h.calls.map((call) => call.method)).toEqual(['hostsPairApprovals', 'hostsPairApprovals', 'hostsPairApprovalDecide', 'hostsPairApprovals', 'hostsPairApprovalDecide'])
      expect(h.calls[2]?.args).toEqual(['r1', 'approve'])
      expect(h.calls[4]?.args).toEqual(['r1', 'deny'])
      expect(output[0]).toContain('K7QX-M2PA  Windows  from 10.0.0.7')
      expect(output[1]).toBe('Approved Windows (K7QX-M2PA).')
    } finally { await h.remote.stop(true) }
  })

  test('a value that is not a check code, or no open request, decides nothing', async () => {
    const h = harness()
    try {
      // 0 and O are not in the alphabet, so a misread code is refused before any call.
      await expect(runHostCommand(['approve', 'K0QX-M2PA', ...h.end], () => {})).rejects.toThrow('not a check code')
      expect(h.calls).toEqual([])
      await expect(runHostCommand(['approve', 'AAAA-BBBB', ...h.end], () => {})).rejects.toThrow('No open approval request')
      expect(h.calls.map((call) => call.method)).toEqual(['hostsPairApprovals'])
    } finally { await h.remote.stop(true) }
  })

  test('pair with no code sends an approval request with a printed check code', async () => {
    const h = harness()
    const output: string[] = []
    try {
      await runHostCommand(['pair', 'http://10.0.0.2:3000', ...h.end], (line) => output.push(line))
      const [request] = h.calls[0]?.args as [{ url: string; checkCode: string; code?: string }]
      expect(request.url).toBe('http://10.0.0.2:3000')
      expect(request.code).toBeUndefined()
      expect(normalizeCheckCode(request.checkCode)).toBe(request.checkCode)
      expect(output[0]).toContain(request.checkCode)
    } finally { await h.remote.stop(true) }
  })
})
