import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSoftware } from '@solus/server/updates/agent-software'
import { ClaudeSoftwareAdapter } from '@solus/server/updates/claude-software-adapter'
import { CodexSoftwareAdapter } from '@solus/server/updates/codex-software-adapter'

let root: string
const checksum = 'a'.repeat(64)
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'solus-agent-source-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

test.each([
  ['darwin', 'arm64', 'aarch64-apple-darwin'], ['darwin', 'x64', 'x86_64-apple-darwin'],
  ['linux', 'arm64', 'aarch64-unknown-linux-musl'], ['linux', 'x64', 'x86_64-unknown-linux-musl'],
  ['win32', 'x64', 'x86_64-pc-windows-msvc'], ['win32', 'arm64', 'aarch64-pc-windows-msvc'],
] as const)('Codex selects the complete native package for %s/%s', async (platform, arch, target) => {
  const metadataUrls: string[] = []
  const downloads: string[] = []
  const software = new AgentSoftware(new CodexSoftwareAdapter({
    platform,
    arch,
    baseUrl: 'https://approved.example/codex/',
    metadata: async (url) => {
      metadataUrls.push(url)
      return JSON.stringify({ tag_name: 'rust-v0.170.0', assets: [{ name: 'codex-package-' + target + '.tar.gz', digest: 'sha256:' + checksum }] })
    },
  }), {
    root,
    existingBinary: () => null,
    download: async (url) => { downloads.push(url); throw new Error('fixture stops before downloading') },
  })
  await expect(software.install()).rejects.toThrow('fixture stops before downloading')
  expect(metadataUrls).toEqual(['https://approved.example/codex/channels/latest'])
  expect(downloads).toEqual(['https://approved.example/codex/releases/0.170.0/codex-package-' + target + '.tar.gz'])
})

test.each([
  ['darwin', 'arm64', false, 'darwin-arm64'], ['darwin', 'x64', false, 'darwin-x64'],
  ['linux', 'x64', false, 'linux-x64'], ['linux', 'arm64', true, 'linux-arm64-musl'],
  ['win32', 'x64', false, 'win32-x64'],
] as const)('Claude selects the verified native binary for %s/%s', async (platform, arch, musl, target) => {
  const metadataUrls: string[] = []
  const downloads: string[] = []
  const software = new AgentSoftware(new ClaudeSoftwareAdapter({
    platform,
    arch,
    musl,
    cpuInfo: 'flags: sse4_2',
    baseUrl: 'https://approved.example/claude',
    metadata: async (url) => {
      metadataUrls.push(url)
      return url.endsWith('/latest') ? '2.1.211\n' : JSON.stringify({ platforms: { [target]: { checksum } } })
    },
  }), {
    root,
    existingBinary: () => null,
    download: async (url) => { downloads.push(url); throw new Error('fixture stops before downloading') },
  })
  await expect(software.install()).rejects.toThrow('fixture stops before downloading')
  expect(metadataUrls).toEqual(['https://approved.example/claude/latest', 'https://approved.example/claude/2.1.211/manifest.json'])
  expect(downloads).toEqual(['https://approved.example/claude/2.1.211/' + target + '/' + (platform === 'win32' ? 'claude.exe' : 'claude')])
})

test('a blocked approved mirror does not fall back to npm or another source', async () => {
  const urls: string[] = []
  const software = new AgentSoftware(new CodexSoftwareAdapter({
    baseUrl: 'https://approved.example/codex',
    metadata: async (url) => { urls.push(url); throw new Error('blocked') },
  }), {
    root,
    existingBinary: () => null,
    npmView: async () => { throw new Error('must not use npm') },
  })
  await expect(software.install()).rejects.toThrow('blocked')
  expect(urls).toEqual(['https://approved.example/codex/channels/latest'])
})

test('a missing checksum prevents a download', async () => {
  let downloaded = false
  const software = new AgentSoftware(new CodexSoftwareAdapter({
    platform: 'linux',
    arch: 'x64',
    metadata: async () => JSON.stringify({ tag_name: 'rust-v0.170.0', assets: [{ name: 'codex-package-x86_64-unknown-linux-musl.tar.gz', digest: '' }] }),
  }), {
    root,
    existingBinary: () => null,
    download: async () => { downloaded = true },
  })
  await expect(software.install()).rejects.toThrow()
  expect(downloaded).toBe(false)
})

test.each(['http://mirror.example', 'https://user:secret@mirror.example', 'https://mirror.example?token=secret'])('refuses an unsafe source: %s', async (baseUrl) => {
  const software = new AgentSoftware(new CodexSoftwareAdapter({
    baseUrl,
  }), {
    root,
    existingBinary: () => null,
  })
  await expect(software.install()).rejects.toThrow('HTTPS URL without credentials')
})

test('an existing npm install uses only its configured registry', async () => {
  const specs: string[] = []
  const software = new AgentSoftware(new CodexSoftwareAdapter({
    metadata: async () => { throw new Error('must not use a public native source') },
  }), {
    root,
    existingBinary: () => '/fixture/node_modules/@openai/codex/bin/codex.js',
    version: async () => '1.0.0',
    npmView: async (spec) => { specs.push(spec); return '"2.0.0"' },
  })
  await software.check()
  expect(software.status.check).toMatchObject({ kind: 'available', latestVersion: '2.0.0' })
  expect(specs).toEqual(['@openai/codex@latest'])
  await expect(software.install()).rejects.toThrow('npm install -g')
})

test.each([
  ['missing npm', async () => null, 'npm is required'],
  ['invalid output', async () => 'not json', 'unknown version'],
  ['blocked registry', async () => { throw new Error('npm registry blocked') }, 'npm registry blocked'],
] as const)('an npm check reports %s without changing sources', async (_name, npmView, message) => {
  let nativeLookups = 0
  const software = new AgentSoftware(new CodexSoftwareAdapter({
    metadata: async () => { nativeLookups++; throw new Error('must not use a public native source') },
  }), {
    root,
    existingBinary: () => '/fixture/node_modules/@openai/codex/bin/codex.js',
    version: async () => '1.0.0',
    npmView,
  })
  await software.check()
  expect(software.status.check).toMatchObject({ kind: 'error', message: expect.stringContaining(message) })
  expect(nativeLookups).toBe(0)
})
