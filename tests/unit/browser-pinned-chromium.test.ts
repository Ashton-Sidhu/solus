import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  PINNED_CHROMIUM_VERSION,
  PinnedChromium,
  pinnedChromiumRelease,
  type PinnedChromiumRelease,
} from '@solus/server/browser/pinned-chromium'

/**
 * The Chromium a standalone server drives.
 *
 * Chromium blocks the compromised eMudhra intermediate CAs from 156.0.8078.70
 * (crrev.com/c/8627687). The headless shell has no CRLSet, so a build below
 * that trusts certificates from those CAs. The pin is the fix, and the checks
 * on the download are what make the pin mean anything.
 */

function versionParts(version: string): number[] {
  return version.split('.').map(Number)
}

function atLeast(version: string, minimum: string): boolean {
  const [a, b] = [versionParts(version), versionParts(minimum)]
  for (let i = 0; i < 4; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

describe('the pinned release', () => {
  test('is a build that blocks the compromised eMudhra CAs', () => {
    expect(atLeast(PINNED_CHROMIUM_VERSION, '156.0.8078.70')).toBe(true)
  })

  test('downloads chrome-headless-shell for this host from the Chrome for Testing bucket', () => {
    const linux = pinnedChromiumRelease('linux', 'x64')
    expect(linux?.url).toBe(
      `https://storage.googleapis.com/chrome-for-testing-public/${PINNED_CHROMIUM_VERSION}/linux64/chrome-headless-shell-linux64.zip`,
    )
    expect(linux?.executable).toBe('chrome-headless-shell-linux64/chrome-headless-shell')
    expect(pinnedChromiumRelease('linux', 'arm64')?.platform).toBe('linux-arm64')
    expect(pinnedChromiumRelease('darwin', 'arm64')?.platform).toBe('mac-arm64')
    expect(pinnedChromiumRelease('darwin', 'x64')?.platform).toBe('mac-x64')
    expect(pinnedChromiumRelease('win32', 'arm64')?.executable).toBe('chrome-headless-shell-win64/chrome-headless-shell.exe')
  })

  test('has a byte count and a SHA-256 for every platform', () => {
    for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'ia32'], ['win32', 'x64']]) {
      const release = pinnedChromiumRelease(platform!, arch!)
      expect(release?.bytes).toBeGreaterThan(50_000_000)
      expect(release?.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('is absent where Chrome for Testing has no build', () => {
    expect(pinnedChromiumRelease('linux', 'ia32')).toBeNull()
    expect(pinnedChromiumRelease('freebsd', 'x64')).toBeNull()
  })
})

const ARCHIVE = new TextEncoder().encode('a chrome-headless-shell zip')

function release(overrides: Partial<PinnedChromiumRelease> = {}): PinnedChromiumRelease {
  return {
    version: '156.0.8078.70',
    platform: 'linux64',
    url: 'https://storage.googleapis.com/chrome.zip',
    bytes: ARCHIVE.byteLength,
    sha256: createHash('sha256').update(ARCHIVE).digest('hex'),
    executable: 'chrome-headless-shell-linux64/chrome-headless-shell',
    ...overrides,
  }
}

function harness(pinned: PinnedChromiumRelease, body: Uint8Array = ARCHIVE) {
  const root = mkdtempSync(join(tmpdir(), 'solus-pinned-chromium-'))
  let downloads = 0
  const chromium = new PinnedChromium({
    release: pinned,
    root,
    fetch: async () => {
      downloads += 1
      return new Response(body)
    },
    extract: async (_zipPath, directory) => {
      const executable = join(directory, pinned.executable)
      mkdirSync(dirname(executable), { recursive: true })
      writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 })
    },
  })
  return { chromium, root, downloads: () => downloads, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('installing the pinned build', () => {
  test('one download serves every caller and replaces an older pin', async () => {
    const { chromium, root, downloads, cleanup } = harness(release())
    try {
      mkdirSync(join(root, '154.0.8037.92'))
      expect(chromium.installed()).toBeNull()
      const [first, second] = await Promise.all([chromium.ensure(), chromium.ensure()])
      expect(first).toBe(join(root, '156.0.8078.70', 'chrome-headless-shell-linux64', 'chrome-headless-shell'))
      expect(second).toBe(first)
      expect(downloads()).toBe(1)
      expect(chromium.installed()).toBe(first)
      // The older pin and the staging directory are gone.
      expect(readdirSync(root)).toEqual(['156.0.8078.70'])
      await chromium.ensure()
      expect(downloads()).toBe(1)
    } finally {
      cleanup()
    }
  })

  test('a download that fails its SHA-256 check installs nothing, and the next try downloads again', async () => {
    const { chromium, root, downloads, cleanup } = harness(release({ sha256: '0'.repeat(64) }))
    try {
      await expect(chromium.ensure()).rejects.toThrow('SHA-256')
      expect(chromium.installed()).toBeNull()
      expect(readdirSync(root)).toEqual([])
      await expect(chromium.ensure()).rejects.toThrow('SHA-256')
      expect(downloads()).toBe(2)
    } finally {
      cleanup()
    }
  })

  test('a download larger than the pinned build is refused', async () => {
    const { chromium, root, cleanup } = harness(release(), new Uint8Array(ARCHIVE.byteLength + 1))
    try {
      await expect(chromium.ensure()).rejects.toThrow('larger than the pinned build')
      expect(existsSync(join(root, '156.0.8078.70'))).toBe(false)
    } finally {
      cleanup()
    }
  })
})
