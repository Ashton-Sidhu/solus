import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  compareVersions,
  isBrewManaged,
  isTarballInstall,
  normalizeVersion,
  replaceInstallDirectory,
  verifyArchiveSha256,
} from '../../apps/cli/src/lib/update'

// A server update replaces the running installation on the next restart. These
// tests protect version selection, artifact integrity, and rollback of a failed swap.

describe('the server update command', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solus-cli-update-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('compares release versions without treating a leading v as part of the version', () => {
    expect(normalizeVersion('v1.12.0\n')).toBe('1.12.0')
    expect(compareVersions('1.12.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.12.0', '1.12')).toBe(0)
  })

  test('recognizes supported package layouts', () => {
    const installDir = join(dir, 'solus')
    mkdirSync(join(installDir, 'bin'), { recursive: true })
    mkdirSync(join(installDir, 'libexec', 'server'), { recursive: true })
    mkdirSync(join(installDir, 'libexec', 'cli'), { recursive: true })
    writeFileSync(join(installDir, 'bin', 'node'), '')
    writeFileSync(join(installDir, 'libexec', 'server', 'standalone.js'), '')
    writeFileSync(join(installDir, 'libexec', 'cli', 'solus.js'), '')

    expect(isTarballInstall(installDir)).toBe(true)
    expect(isBrewManaged('/opt/homebrew/Cellar/solus/1.2.3')).toBe(true)
  })

  test('verifies the selected release artifact against SHA256SUMS', () => {
    const artifact = join(dir, 'solus.tar.gz')
    writeFileSync(artifact, 'release bytes')
    const digest = createHash('sha256').update('release bytes').digest('hex')
    verifyArchiveSha256(artifact, `${digest}  solus.tar.gz\n`, 'solus.tar.gz')
    expect(() => verifyArchiveSha256(artifact, `${'0'.repeat(64)}  solus.tar.gz\n`, 'solus.tar.gz'))
      .toThrow('Checksum mismatch')
  })

  test('activates a sibling install and preserves the previous version as a backup', () => {
    const installDir = join(dir, 'solus')
    const nextDir = join(dir, 'solus.next')
    const backupDir = join(dir, 'solus.backup')
    mkdirSync(installDir)
    mkdirSync(nextDir)
    writeFileSync(join(installDir, 'version'), 'old')
    writeFileSync(join(nextDir, 'version'), 'new')

    replaceInstallDirectory(installDir, nextDir, backupDir)

    expect(readFileSync(join(installDir, 'version'), 'utf8')).toBe('new')
    expect(readFileSync(join(backupDir, 'version'), 'utf8')).toBe('old')
  })

  test('restores the current install when activation fails', () => {
    const installDir = join(dir, 'solus')
    const missingNextDir = join(dir, 'missing-next')
    const backupDir = join(dir, 'solus.backup')
    mkdirSync(installDir)
    writeFileSync(join(installDir, 'version'), 'old')

    expect(() => replaceInstallDirectory(installDir, missingNextDir, backupDir)).toThrow()
    expect(readFileSync(join(installDir, 'version'), 'utf8')).toBe('old')
    expect(existsSync(backupDir)).toBe(false)
  })
})
