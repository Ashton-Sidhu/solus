import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateStatusService } from '@solus/server/updates/update-status-service'
import { AgentSoftware } from '@solus/server/updates/agent-software'
import { ClaudeSoftwareAdapter, type ClaudeSoftwareOptions } from '@solus/server/updates/claude-software-adapter'
import { CodexSoftwareAdapter } from '@solus/server/updates/codex-software-adapter'
import { AgentExecutable } from '@solus/server/cli-env'
import type { HostInstallKind, HostUpdateStatus } from '@solus/contracts/host-update-types'
import type { SetupAgent } from '@solus/contracts/types'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'solus-update-status-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function fixture(install: HostInstallKind = 'managed') {
  let now = 0
  let installed: string | null = '1.0.0'
  let failClaude = false
  let allowed = true
  const calls: string[] = []
  const published: HostUpdateStatus[] = []
  const payload = 'verified executable'
  const checksum = createHash('sha256').update(payload).digest('hex')
  const software = (agent: SetupAgent) => {
    const path = join(root, agent)
    const executable = new AgentExecutable(agent, path)
    const adapterOptions: ClaudeSoftwareOptions = {
      platform: 'linux', arch: 'x64', musl: false, cpuInfo: 'flags: sse4_2',
      metadata: async (url) => {
        if (url.endsWith('/latest')) calls.push(agent)
        if (agent === 'claude' && failClaude) throw new Error('Registry unavailable')
        if (agent === 'codex') return JSON.stringify({ tag_name: 'rust-v2.0.0', assets: [{ name: 'codex-package-x86_64-unknown-linux-musl.tar.gz', digest: 'sha256:' + checksum }] })
        return url.endsWith('/latest') ? '2.0.0' : JSON.stringify({ platforms: { 'linux-x64': { checksum } } })
      },
    }
    return new AgentSoftware(agent === 'claude' ? new ClaudeSoftwareAdapter(adapterOptions) : new CodexSoftwareAdapter(adapterOptions), {
      root: path, now: () => now,
      existingBinary: () => '/fixture/' + agent,
      version: async () => executable.selection?.enabled !== false && executable.selection ? executable.selection.version : installed,
      download: async (_url, destination) => { await writeFile(destination, payload) }, verify: async () => {},
    })
  }
  const agents = { claude: software('claude'), codex: software('codex') }
  const service = new UpdateStatusService({
    currentVersion: '1.0.0', install, now: () => now, canCheck: () => allowed, agents,
    latest: async () => { calls.push('solus'); return { version: '2.0.0', url: 'https://vendor.example/latest' } },
    publish: (status) => { published.push(status) },
  })
  return { service, agents, calls, published, advance: () => { now += 60_000 }, upgrade: () => { installed = '2.0.0' }, absent: () => { installed = null }, fail: () => { failClaude = true }, disallow: () => { allowed = false } }
}

test('a cloud host leaves its image and agent software to the control plane', async () => {
  const f = fixture('cloud')
  f.service.start()
  await f.service.check()
  await f.service.refreshProviders()
  f.service.refreshInstallations()
  expect(f.calls).toEqual([])
  expect(f.published).toEqual([])
  expect(f.service.status.check).toEqual({ kind: 'idle', reason: 'Kept up to date by Solus cloud.' })
  f.service.stop()
})

test('one client cannot trigger repeated host and agent checks inside one minute', async () => {
  const f = fixture()
  await Promise.all([f.service.check(), f.service.check()])
  await f.service.check()
  expect(f.calls.sort()).toEqual(['claude', 'codex', 'solus'])
  f.advance()
  await f.service.check()
  expect(f.calls).toHaveLength(6)
})

test('a failed source retains its known release without blocking other checks', async () => {
  const f = fixture()
  await f.service.check()
  f.fail()
  f.advance()
  await f.service.check()
  expect(f.service.status.providers[0]?.check).toMatchObject({ kind: 'error', latestVersion: '2.0.0' })
  expect(f.service.status.providers[1]?.check.kind).toBe('available')
  expect(f.service.status.check.kind).toBe('available')
})

test('an agent install updates the host projection without a completion callback or a second state owner', async () => {
  const f = fixture()
  await f.service.check()
  const old = f.published.at(-1)!
  await f.agents.claude.install('native')
  expect(f.service.status.providers[0]).toBe(f.agents.claude.status)
  expect(f.service.status.providers[0]?.installedVersion).toBe('2.0.0')
  expect(f.service.status.providers[0]?.check.kind).toBe('up-to-date')
  expect(f.published.at(-1)?.providers[0]?.update?.phase).toBe('succeeded')
  expect(old.providers[0]?.installedVersion).toBe('1.0.0')
})

test('a model list change checks each agent once and skips the manual limit', async () => {
  const f = fixture()
  await f.service.check()
  f.calls.length = 0
  await Promise.all([f.service.refreshProviders(), f.service.refreshProviders()])
  expect(f.calls.sort()).toEqual(['claude', 'codex'])
})

test('desktop and source installs do not ask for a separate Solus update', async () => {
  for (const install of ['desktop', 'source'] as const) {
    const f = fixture(install)
    f.absent()
    await f.service.check()
    expect(f.calls).toEqual([])
    expect(f.service.status.check.kind).toBe('idle')
    expect(f.agents.claude.status.check).toEqual({ kind: 'idle', reason: 'Not installed' })
  }
})

test('checks start after ten seconds, repeat every four hours, and stop with the host', () => {
  const first = spyOn(globalThis, 'setTimeout')
  const interval = spyOn(globalThis, 'setInterval')
  const clearFirst = spyOn(globalThis, 'clearTimeout')
  const clearIntervalTimer = spyOn(globalThis, 'clearInterval')
  const f = fixture()
  try {
    f.service.start()
    f.service.start()
    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith(expect.any(Function), 10_000)
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 4 * 60 * 60 * 1_000)
    f.service.stop()
    expect(clearFirst).toHaveBeenCalledWith(first.mock.results[0]?.value)
    expect(clearIntervalTimer).toHaveBeenCalledWith(interval.mock.results[0]?.value)
  } finally {
    f.service.stop()
    first.mockRestore(); interval.mockRestore(); clearFirst.mockRestore(); clearIntervalTimer.mockRestore()
  }
})

test('organization policy blocks both scheduled and model-triggered checks', async () => {
  const f = fixture()
  f.disallow()
  await f.service.check(false)
  await f.service.refreshProviders()
  expect(f.calls).toEqual([])
})
