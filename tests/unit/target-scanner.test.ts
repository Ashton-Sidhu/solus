import { describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { processFact } from './running-server-fixtures'
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { ServerDiscovery } = await import('@solus/server/host/running-servers/discovery')
const { windowsListeners, parseLsofListeners, procSocketListeners } = await import('@solus/server/host/running-servers/listeners')
const { parseProcessFacts, parseWindowsProcesses } = await import('@solus/server/host/running-servers/processes')

describe('listener address filtering', () => {
  test('Windows keeps local addresses and names IPv6 without relying on translated state', () => {
    expect(windowsListeners(' TCP [::]:3000 [::]:0 ABHÖREN 123\n TCP 127.0.0.1:5173 0.0.0.0:0 LISTENING 456\n TCP 192.168.1.2:8000 0.0.0.0:0 LISTENING 789\n TCP 127.0.0.1:5173 127.0.0.1:123 ESTABLISHED 456')).toEqual([
      { pid: 123, port: 3000, address: '::1', command: '' }, { pid: 456, port: 5173, address: '127.0.0.1', command: '' },
    ])
  })
  test('macOS excludes LAN-only sockets and normalizes wildcard listeners', () => {
    expect(parseLsofListeners('p123\ncnode\nn*:3000\nn[::1]:3001\nn192.168.1.1:3002')).toEqual([
      { pid: 123, command: 'node', port: 3000, address: '127.0.0.1' }, { pid: 123, command: 'node', port: 3001, address: '::1' },
    ])
  })
  test('Linux reads listening socket inodes without lsof', () => {
    expect(procSocketListeners('header\n 0: 0100007F:0BB8 00000000:0000 0A 0 0 0 0 0 987\n 1: 0201A8C0:0BB9 00000000:0000 0A 0 0 0 0 0 988\n 2: 0100007F:0BBA 00000000:0000 01 0 0 0 0 0 989')).toEqual([{ inode: '987', port: 3000, address: '127.0.0.1' }])
  })
})

test('provider CLIs and direct host children are protected, a server in the Solus repo is not', () => {
  const facts = parseProcessFacts([
    '100 10 100 Tue Nov 17 12:00:00 2026 node /Users/me/node_modules/claude/cli.js',
    '101 10 101 Tue Nov 17 12:00:01 2026 node /Users/me/solus/node_modules/vite/bin/vite.js',
    '102 10 102 Tue Nov 17 12:00:02 2026 /usr/local/bin/codex app-server',
    '103 10 103 Tue Nov 17 12:00:03 2026 node /project/api/server.js',
  ].join('\n'), [103])
  expect(facts.get(100)?.protected).toBe(true)
  expect(facts.get(101)?.protected).toBe(false)
  expect(facts.get(102)?.protected).toBe(true)
  expect(facts.get(103)?.protected).toBe(true)
  expect(facts.get(101)?.identity).toBe('Tue Nov 17 12:00:01 2026')
})

test('Windows metadata has process names and creation identity instead of empty names', () => {
  const facts = parseWindowsProcesses(JSON.stringify([{ ProcessId: 123, ParentProcessId: 10, CreationDate: '2026-11-20T00:00:00Z', Name: 'node.exe', CommandLine: 'node api.js' }]))
  expect(facts.get(123)?.name).toBe('node.exe')
  expect(facts.get(123)?.identity).toBe('2026-11-20T00:00:00Z')
})

function scannerSetup() {
  let now = 0
  let configured: { cwd: string; url: string }[] = []
  let succeeds = false
  const probe = mock(async (_url: URL) => succeeds ? { kind: 'http' as const, protocol: 'https' as const, response: { protocol: 'https' as const, statusCode: 401, contentType: 'application/json', pageTitle: null } } : { kind: 'other' as const })
  const scanner = new ServerDiscovery({
    listeners: async () => [{ pid: 100, port: 3000, command: 'node' }, { pid: 200, port: 4000, command: 'unrelated' }, { pid: 300, port: 5000, command: 'codex' }, { pid: 100, port: 6000, command: 'node' }, { pid: 400, port: 6000, command: 'other' }],
    processes: async () => new Map([processFact(100), processFact(200, { sessionId: null }), processFact(300, { protected: true }), processFact(400)].map((fact) => [fact.pid, fact])),
    directories: async () => new Map([[100, '/project/api']]), tags: async () => {},
    configured: async () => configured, probe, locate: async () => {}, now: () => now,
  })
  return { scanner, probe, setTime: (value: number) => { now = value }, configure: (url: string) => { configured = [{ cwd: '/project', url }] }, start: () => { succeeds = true } }
}

test('discovery lists an owned API before HTTP starts and sends zero probes to any listener', async () => {
  const s = scannerSetup()
  const servers = await s.scanner.discover()
  expect(servers).toHaveLength(1)
  expect(servers[0].process.pid).toBe(100)
  expect(servers[0].endpoints.map((endpoint) => endpoint.port)).toEqual([3000])
  expect(servers[0].endpoints[0].response).toBeNull()
  expect(s.probe).not.toHaveBeenCalled()
})

test('an explicit HTTPS API URL retains path, query and fragment, and a failed startup retries', async () => {
  const s = scannerSetup()
  const url = 'https://localhost:3000/admin?api=v1#health'
  s.configure(url)
  await s.scanner.discover()
  expect(s.probe).toHaveBeenCalledTimes(1)
  s.start()
  s.setTime(14_999)
  await s.scanner.discover()
  expect(s.probe).toHaveBeenCalledTimes(1)
  s.setTime(15_000)
  const [server] = await s.scanner.discover()
  expect(s.probe).toHaveBeenCalledTimes(2)
  expect(s.probe.mock.calls[0][0].href).toBe(url)
  expect(server.endpoints[0].url).toBe(url)
  expect(server.endpoints[0].response?.statusCode).toBe(401)
})

test('a generic API CLI is not confused with a provider CLI', () => {
  const facts = parseProcessFacts('100 10 100 Tue Nov 17 12:00:00 2026 node /project/api/cli.js')
  expect(facts.get(100)?.protected).toBe(false)
})

test('Windows attributes only descendants of a provider owned by this host', () => {
  const row = (ProcessId: number, ParentProcessId: number, Name: string, CommandLine: string) => ({ ProcessId, ParentProcessId, Name, CommandLine, CreationDate: '2026-11-20T00:00:00Z' })
  const facts = parseWindowsProcesses(JSON.stringify([
    row(100, process.pid, 'codex.exe', 'codex.exe app-server'),
    row(101, 100, 'node.exe', 'node.exe api.js'),
    row(200, 10, 'codex.exe', 'codex.exe app-server'),
    row(201, 200, 'node.exe', 'node.exe api.js'),
  ]))
  expect(facts.get(100)?.protected).toBe(true)
  expect(facts.get(101)?.agentOwned).toBe(true)
  expect(facts.get(201)?.agentOwned).not.toBe(true)
})
