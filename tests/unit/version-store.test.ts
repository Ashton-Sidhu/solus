import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activateVersion,
  currentVersionDir,
  currentVersionName,
  finalizeStagedVersion,
  pruneStaleDownloads,
  removeVersion,
  versionDir,
  versionsDir,
} from '../../apps/cli/src/lib/version-store'

// The owned runtime directory keeps every version immutable and repoints
// `current` at the active one with a single rename, so a reader never sees a
// half-updated link — this is the primitive the supervisor's rollback and the
// portable installer both build on.

describe('version-store', () => {
  let runtimeDir: string
  afterEach(() => { rmSync(runtimeDir, { recursive: true, force: true }) })

  function makeVersion(version: string): string {
    const dir = versionDir(runtimeDir, version)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'marker'), version)
    return dir
  }

  function setup(): void {
    runtimeDir = mkdtempSync(join(tmpdir(), 'solus-version-store-'))
    mkdirSync(versionsDir(runtimeDir), { recursive: true })
  }

  test('current is null until a version is activated', () => {
    setup()
    expect(currentVersionDir(runtimeDir)).toBeNull()
    expect(currentVersionName(runtimeDir)).toBeNull()
  })

  test('activation points current at the real version directory', () => {
    setup()
    const dir = makeVersion('1.0.0')
    activateVersion(runtimeDir, '1.0.0')
    expect(currentVersionDir(runtimeDir)).toBe(realpathSync(dir))
    expect(currentVersionName(runtimeDir)).toBe('1.0.0')
  })

  test('a second activation repoints the link with a single rename, never leaving it missing', () => {
    setup()
    makeVersion('1.0.0')
    makeVersion('1.1.0')
    activateVersion(runtimeDir, '1.0.0')
    activateVersion(runtimeDir, '1.1.0')
    expect(currentVersionName(runtimeDir)).toBe('1.1.0')
    // No leftover staging symlink from the swap.
    expect(existsSync(join(runtimeDir, `current.next-${process.pid}`))).toBe(false)
  })

  test('activating a version that was never installed fails loudly', () => {
    setup()
    expect(() => activateVersion(runtimeDir, '9.9.9')).toThrow('not installed')
  })

  test('finalizeStagedVersion moves the staged payload into versions/ and discards the rest of the stage', () => {
    setup()
    const stage = mkdtempSync(join(versionsDir(runtimeDir), '.download-'))
    const staged = join(stage, 'install')
    mkdirSync(staged)
    writeFileSync(join(staged, 'marker'), '1.2.0')
    writeFileSync(join(stage, 'archive.tar.gz'), 'leftover')

    finalizeStagedVersion(staged, runtimeDir, '1.2.0')

    expect(existsSync(versionDir(runtimeDir, '1.2.0'))).toBe(true)
    expect(existsSync(stage)).toBe(false)
  })

  test('pruneStaleDownloads removes an abandoned staging directory left by an interrupted download', () => {
    setup()
    const stage = mkdtempSync(join(versionsDir(runtimeDir), '.download-'))
    writeFileSync(join(stage, 'partial.tar.gz'), 'incomplete')
    makeVersion('1.0.0')

    pruneStaleDownloads(runtimeDir)

    expect(existsSync(stage)).toBe(false)
    expect(existsSync(versionDir(runtimeDir, '1.0.0'))).toBe(true)
  })

  test('removeVersion is a no-op for a version that does not exist', () => {
    setup()
    expect(() => removeVersion(runtimeDir, '9.9.9')).not.toThrow()
  })

  test('the current symlink target basename always matches the activated version', () => {
    setup()
    makeVersion('2.0.0')
    activateVersion(runtimeDir, '2.0.0')
    expect(readlinkSync(join(runtimeDir, 'current'))).toBe(versionDir(runtimeDir, '2.0.0'))
  })
})
