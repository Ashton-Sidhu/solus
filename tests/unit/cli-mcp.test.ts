import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientFrameSchema } from '@solus/contracts/host-socket'
import { parseMcpCommand, runMcpCommand } from '../../apps/cli/src/lib/mcp'

// WHY: on a host with no screen, `solus mcp` is how the owner connects an outside
// app (docs/outside-apps.md): the addresses, the commands for Claude Code and
// Codex, and a one-time pairing code with the access they choose. It uses the
// same RPCs as the app, through the local socket that admits the owner.

const folders: string[] = []
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }) })

function dataDir(): string {
  const folder = mkdtempSync(join(tmpdir(), 'solus-cli-mcp-'))
  folders.push(folder)
  return folder
}

/** A running server on loopback that answers the CLI's RPCs. */
function server(folder: string, answer: (method: string, args: unknown[]) => unknown) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const remote = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, bunServer) { if (bunServer.upgrade(request)) return; return new Response('Not found', { status: 404 }) },
    websocket: {
      message(socket, text) {
        const frame = clientFrameSchema.parse(JSON.parse(String(text)))
        if (frame.t === 'hello') socket.send(JSON.stringify({ t: 'welcome', epoch: 'test', seq: 0, recovered: false }))
        else if (frame.t === 'rpc') {
          calls.push({ method: frame.method, args: frame.args })
          socket.send(JSON.stringify({ t: 'result', id: frame.id, result: answer(frame.method, frame.args) }))
        }
      },
    },
  })
  writeFileSync(join(folder, 'server.lock'), JSON.stringify({ pid: process.pid, port: remote.port, host: '127.0.0.1', startedAt: Date.now() }))
  return { calls, stop: () => remote.stop(true) }
}

describe('parsing solus mcp', () => {
  test('a pairing code gives write access unless the person chooses another', () => {
    const folder = dataDir()
    expect(parseMcpCommand(['--data-dir', folder])).toEqual({ kind: 'addresses', dataDir: folder })
    expect(parseMcpCommand(['code', '--data-dir', folder])).toEqual({ kind: 'code', dataDir: folder, access: 'write' })
    expect(parseMcpCommand(['code', '--access', 'read', '--data-dir', folder])).toEqual({ kind: 'code', dataDir: folder, access: 'read' })
    expect(parseMcpCommand(['code', '--access=full', '--data-dir', folder])).toEqual({ kind: 'code', dataDir: folder, access: 'full' })
  })

  test('an access that does not exist, an unknown command, or an access without a code is refused', () => {
    expect(() => parseMcpCommand(['code', '--access', 'admin'])).toThrow('--access requires read, write, or full')
    expect(() => parseMcpCommand(['code', '--access'])).toThrow('--access requires a value')
    expect(() => parseMcpCommand(['login'])).toThrow('Unknown mcp command: login')
    expect(() => parseMcpCommand(['--access', 'read'])).toThrow('Unknown mcp option: --access')
  })
})

describe('solus mcp on the running server', () => {
  test('prints both addresses, and the commands use the public one that a browser elsewhere can open', async () => {
    const folder = dataDir()
    const host = server(folder, () => ({ localUrl: 'http://localhost:3000/mcp', publicUrl: 'https://box.solus.dev/mcp' }))
    const output: string[] = []
    try {
      await runMcpCommand(['--data-dir', folder], (line) => output.push(line))
    } finally { await host.stop() }
    expect(host.calls).toEqual([{ method: 'connectionsAppEndpoint', args: [] }])
    const text = output.join('\n')
    expect(text).toContain('On this computer: http://localhost:3000/mcp')
    expect(text).toContain('From anywhere:    https://box.solus.dev/mcp')
    expect(text).toContain('claude mcp add --transport http solus https://box.solus.dev/mcp\n  claude mcp login solus')
    expect(text).toContain('codex mcp add solus --url https://box.solus.dev/mcp\n  codex mcp login solus')
    expect(text).toContain('add --no-browser to the login command')
    expect(text).toContain('pairing code from `solus mcp code`')
  })

  test('with no public address, the commands use the local one and the person learns how to get one', async () => {
    const folder = dataDir()
    const host = server(folder, () => ({ localUrl: 'http://localhost:3000/mcp', publicUrl: null }))
    const output: string[] = []
    try {
      await runMcpCommand(['--data-dir', folder], (line) => output.push(line))
    } finally { await host.stop() }
    const text = output.join('\n')
    expect(text).toContain('From anywhere:    none. Link the host with `solus connect`, turn on Tailscale Funnel, or set your own https address')
    expect(text).toContain('claude mcp add --transport http solus http://localhost:3000/mcp')
  })

  // WHY: a host needs no Solus account (plans/035 §0.8): the person sees each address and where it comes from.
  test('lists every address with its source; the commands use the first internet one', async () => {
    const folder = dataDir()
    const host = server(folder, () => ({
      localUrl: 'http://localhost:3000/mcp',
      publicUrl: 'https://solus.example.com/mcp',
      addresses: [
        { source: 'custom', url: 'https://solus.example.com/mcp', reach: 'internet' },
        { source: 'tailscale-serve', url: 'https://box.tail.ts.net/mcp', reach: 'tailnet' },
      ],
    }))
    const output: string[] = []
    try {
      await runMcpCommand(['--data-dir', folder], (line) => output.push(line))
    } finally { await host.stop() }
    const text = output.join('\n')
    expect(text).toContain('    https://solus.example.com/mcp (your own address)\n    https://box.tail.ts.net/mcp (Tailscale Serve, your tailnet only)')
    expect(text).toContain('claude mcp add --transport http solus https://solus.example.com/mcp')
  })

  test('code makes a one-time pairing code for the owner with the chosen access, and says when it ends', async () => {
    const folder = dataDir()
    const host = server(folder, (_method, args) => ({ code: 'ABCD-EFGH', access: (args[0] as { access: string }).access, expiresAt: Date.now() + 10 * 60_000 }))
    const output: string[] = []
    try {
      await runMcpCommand(['code', '--access', 'full', '--data-dir', folder], (line) => output.push(line))
    } finally { await host.stop() }
    expect(host.calls).toEqual([{ method: 'connectionsCreateAppPairingCode', args: [{ access: 'full' }] }])
    expect(output).toEqual([
      'Pairing code: ABCD-EFGH',
      '  Access:  Full',
      '  Expires: in 10 minutes',
      'Type it on the app\'s sign-in page. It works once. Run `solus mcp code` for a new one.',
    ])
  })

  test('a server that is not running gets no request', async () => {
    await expect(runMcpCommand(['code', '--data-dir', dataDir()], () => {})).rejects.toThrow('The Solus server is not running')
  })
})

describe('solus mcp on a cloud host', () => {
  const cloudHost = (tunnel: boolean) => {
    const folder = dataDir()
    writeFileSync(join(folder, 'host-registration.json'), JSON.stringify({ version: 1, registration: { hostId: 'h1', issuer: 'https://cloud.test', jwksUrl: 'https://cloud.test/jwks', directoryUrl: 'https://cloud.test', generation: 1, organizationId: 'org_b' } }))
    if (tunnel) writeFileSync(join(folder, 'host-link.json'), JSON.stringify({ version: 2, hostId: 'h1', desired: 'linked', tunnel: { hostname: 'machine.example.com', proxiedPort: 34118 } }))
    return folder
  }

  test('a member makes the pairing code in their Solus client: the command line makes none', async () => {
    await expect(runMcpCommand(['code', '--data-dir', cloudHost(true)], () => {})).rejects.toThrow('A member of its organization makes one in their Solus client')
  })

  test('the address comes from the records of the machine, with no call to the server', async () => {
    const output: string[] = []
    await runMcpCommand(['--data-dir', cloudHost(true)], (line) => output.push(line))
    const text = output.join('\n')
    expect(text).toContain('From anywhere:    https://machine.example.com/mcp')
    expect(text).not.toContain('On this computer')
    expect(text).toContain('claude mcp add --transport http solus https://machine.example.com/mcp')
    expect(text).toContain('A member of the organization approves it with a pairing code from their Solus client')
  })
})
