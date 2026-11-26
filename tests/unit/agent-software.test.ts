import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderUpdateOperation } from '@solus/contracts/host-update-types'
import { AgentSoftware } from '@solus/server/updates/agent-software'
import { ClaudeSoftwareAdapter } from '@solus/server/updates/claude-software-adapter'
import { AgentExecutable } from '@solus/server/cli-env'

let root: string
let previousSelection: string
const payload = 'a verified native executable'
const checksum = createHash('sha256').update(payload).digest('hex')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'solus-native-install-'))
  await mkdir(join(root, 'releases', 'previous'), { recursive: true })
  await writeFile(join(root, 'releases', 'previous', 'claude'), 'working previous executable', { mode: 0o755 })
  previousSelection = JSON.stringify({ release: 'previous', binary: 'claude', version: '1.0.0' })
  await writeFile(join(root, 'current.json'), previousSelection)
  await mkdir(join(root, 'external'))
  await writeFile(join(root, 'external', 'claude'), 'existing executable', { mode: 0o755 })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function fixture(options: { badChecksum?: boolean; verificationError?: string; downloadError?: boolean; now?: () => number; automatic?: () => boolean; canInstall?: () => boolean } = {}) {
  const operations: ProviderUpdateOperation[] = []
  let downloads = 0
  let checks = 0
  const executable = new AgentExecutable('claude', root)
  const software = new AgentSoftware(new ClaudeSoftwareAdapter({
    platform: 'linux',
    arch: 'x64',
    musl: false,
    cpuInfo: 'flags: sse4_2',
    metadata: async (url) => url.endsWith('/latest') ? '2.0.0' : JSON.stringify({ platforms: { 'linux-x64': { checksum: options.badChecksum ? '0'.repeat(64) : checksum } } }),
  }), {
    root,
    automatic: options.automatic,
    canInstall: options.canInstall,
    existingBinary: () => join(root, 'external', 'claude'),
    version: async (binary) => binary === join(root, 'external', 'claude') ? '1.0.0' : executable.selection?.version ?? null,
    download: async (_url, path) => {
      downloads++
      if (options.downloadError) throw new Error('download blocked')
      await writeFile(path, payload)
    },
    verify: async (path, version) => {
      checks++
      expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(previousSelection)
      expect(await readFile(path, 'utf8')).toBe(payload)
      expect(version).toBe('2.0.0')
      if (options.verificationError) throw new Error(options.verificationError)
    },
    now: options.now ?? Date.now,
  })
  let previous: ProviderUpdateOperation | undefined
  software.on('changed', () => {
    const operation = software.status.update
    if (operation && operation !== previous) { operations.push(operation); previous = operation }
  })
  return { software, operations, downloads: () => downloads, checks: () => checks }
}

test('only a verified release replaces the selection; the previous executable stays intact', async () => {
  const f = fixture()
  await f.software.install()
  expect(new AgentExecutable('claude', root).selection).toMatchObject({ version: '2.0.0', binary: 'claude' })
  expect(await readFile(new AgentExecutable('claude', root).binary!, 'utf8')).toBe(payload)
  expect(await readFile(join(root, 'releases', 'previous', 'claude'), 'utf8')).toBe('working previous executable')
  expect(f.operations.map((operation) => operation.phase)).toEqual(['downloading', 'downloading', 'verifying', 'succeeded'])
  expect(await readdir(root)).toEqual(expect.arrayContaining(['current.json', 'external', 'releases']))
  expect((await readdir(root)).some((name) => name.startsWith('.download-') || name === 'update.lock')).toBe(false)
})

test.each([
  ['checksum mismatch', { badChecksum: true }, 'SHA-256'],
  ['failed app-server initialization', { verificationError: 'app-server did not initialize' }, 'app-server'],
  ['blocked network', { downloadError: true }, 'download blocked'],
] as const)('%s keeps the working selection and clears temporary files', async (_name, options, message) => {
  const f = fixture(options)
  await expect(f.software.install()).rejects.toThrow(message)
  expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(previousSelection)
  expect(f.operations.at(-1)).toMatchObject({ phase: 'failed', message: expect.stringContaining('previous agent version 1.0.0 remains selected') })
  expect((await readdir(root)).sort()).toEqual(['current.json', 'external', 'releases'])
  if ('badChecksum' in options) expect(f.checks()).toBe(0)
})

test('two clients join the same update instead of downloading twice', async () => {
  const f = fixture()
  const first = f.software.install()
  const second = f.software.install()
  expect(second).toBe(first)
  await Promise.all([first, second])
  expect(f.downloads()).toBe(1)
})

test('another server process cannot modify the same installation during an update', async () => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  let resume!: () => void
  const wait = new Promise<void>((resolve) => { resume = resolve })
  const owner = new AgentSoftware(new ClaudeSoftwareAdapter({
    platform: 'linux',
    arch: 'x64',
    musl: false,
    cpuInfo: 'flags: sse4_2',
    metadata: async (url) => url.endsWith('/latest') ? '2.0.0' : JSON.stringify({ platforms: { 'linux-x64': { checksum } } }),
  }), {
    root,
    existingBinary: () => null,
    version: async () => '2.0.0',
    download: async (_url, path) => { entered(); await wait; await writeFile(path, payload) },
    verify: async () => {},
  })
  const running = owner.install()
  await started
  try {
    const other = fixture()
    await expect(other.software.install()).rejects.toThrow('already running')
    expect(other.downloads()).toBe(0)
    await expect(owner.install('existing')).rejects.toThrow('Wait for the current')
  } finally { resume(); await running }
})

test('an install keeps only the new release and the one it replaced', async () => {
  // WHY: each install extracts a new folder of about 200 MB. Nothing removed
  // the old ones, so one host kept five copies of the same Antigravity. The
  // replaced release stays because a running turn may still use it.
  await mkdir(join(root, 'releases', 'older'), { recursive: true })
  const f = fixture()
  await f.software.install()
  const first = new AgentExecutable('claude', root).selection!.release
  expect((await readdir(join(root, 'releases'))).sort()).toEqual([first, 'previous'].sort())

  previousSelection = await readFile(join(root, 'current.json'), 'utf8')
  await f.software.install()
  const second = new AgentExecutable('claude', root).selection!.release
  expect((await readdir(join(root, 'releases'))).sort()).toEqual([first, second].sort())
})

test('switching back uses the original installation without deleting either package', async () => {
  const f = fixture()
  await f.software.install()
  const binary = new AgentExecutable('claude', root).binary!
  await f.software.install('existing')
  expect(new AgentExecutable('claude', root).binary).toBeNull()
  expect(new AgentExecutable('claude', root).selection?.enabled).toBe(false)
  expect(await readFile(binary, 'utf8')).toBe(payload)
  expect(f.operations.at(-1)).toMatchObject({ phase: 'succeeded', version: null })
})

test('checks apply automatic update settings and install policy inside the agent module', async () => {
  let enabled = false
  let allowed = false
  const f = fixture({ automatic: () => enabled, canInstall: () => allowed })
  await f.software.check()
  enabled = true
  await f.software.check()
  expect(f.downloads()).toBe(0)
  allowed = true
  await f.software.check()
  expect(f.software.isUpdating).toBe(true)
  await f.software.install()
  expect(f.downloads()).toBe(1)
})

test('a failed automatic update waits for the next cadence; a manual retry remains available', async () => {
  let now = 0
  const f = fixture({ downloadError: true, now: () => now, automatic: () => true })
  await f.software.check()
  await expect(f.software.install()).rejects.toThrow('download blocked')
  await f.software.check()
  expect(f.software.isUpdating).toBe(false)
  expect(f.downloads()).toBe(1)
  await expect(f.software.install()).rejects.toThrow('download blocked')
  expect(f.downloads()).toBe(2)
  now += 4 * 60 * 60 * 1000
  await f.software.check()
  await expect(f.software.install()).rejects.toThrow('download blocked')
  expect(f.downloads()).toBe(3)
})

test('a failed update preserves the installed version and the available release', async () => {
  const f = fixture({ downloadError: true })
  await f.software.check()
  await expect(f.software.install()).rejects.toThrow('download blocked')
  expect(f.software.status.installedVersion).toBe('1.0.0')
  expect(f.software.status.check).toMatchObject({ kind: 'available', latestVersion: '2.0.0' })
})

test('a delayed pre-install check cannot put the previous version back on screen', async () => {
  let finishRelease!: (version: string) => void
  let releaseStarted!: () => void
  const started = new Promise<void>((resolve) => { releaseStarted = resolve })
  let latestReads = 0
  const executable = new AgentExecutable('claude', root)
  const software = new AgentSoftware(new ClaudeSoftwareAdapter({
    platform: 'linux',
    arch: 'x64',
    musl: false,
    cpuInfo: 'flags: sse4_2',
    metadata: async (url) => {
      if (url.endsWith('/latest') && ++latestReads === 1) {
        releaseStarted()
        return new Promise((resolve) => { finishRelease = resolve })
      }
      return url.endsWith('/latest') ? '2.0.0' : JSON.stringify({ platforms: { 'linux-x64': { checksum } } })
    },
  }), {
    root,
    existingBinary: () => null,
    version: async () => executable.selection!.version,
    download: async (_url, path) => { await writeFile(path, payload) },
    verify: async () => {},
  })
  const checking = software.check()
  await started
  const selected = new Promise<void>((resolve) => {
    software.on('changed', () => { if (software.status.update?.phase === 'succeeded') resolve() })
  })
  const installing = software.install()
  await selected
  expect(software.status.installedVersion).toBe('2.0.0')
  finishRelease('2.0.0')
  await Promise.all([checking, installing])
  expect(software.status.installedVersion).toBe('2.0.0')
  expect(software.status.check.kind).toBe('up-to-date')
})

test('the agent owns CPU compatibility checks before it starts a native install', async () => {
  let fetched = false
  const software = new AgentSoftware(new ClaudeSoftwareAdapter({
    platform: 'linux',
    arch: 'x64',
    cpuInfo: 'flags: sse4_1',
    metadata: async () => { fetched = true; throw new Error('must reject before fetching') },
  }), {
    root,
    existingBinary: () => null,
  })
  await expect(software.install()).rejects.toThrow('SSE4.2')
  expect(fetched).toBe(false)
  expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(previousSelection)
})
