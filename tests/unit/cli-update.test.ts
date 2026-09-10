import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compareVersions, normalizeVersion, verifyArchiveSha256 } from '../../apps/cli/src/lib/update'
import { isManagedVersion } from '../../packages/contracts/src/host-install'

// A server update replaces the running installation on the next restart. These
// tests protect version selection and artifact integrity.

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

  test('recognizes a complete version payload', () => {
    const installDir = join(dir, 'solus')
    mkdirSync(join(installDir, 'bin'), { recursive: true })
    mkdirSync(join(installDir, 'libexec', 'server'), { recursive: true })
    mkdirSync(join(installDir, 'libexec', 'cli'), { recursive: true })
    writeFileSync(join(installDir, 'bin', 'node'), '')
    writeFileSync(join(installDir, 'libexec', 'server', 'standalone.js'), '')
    writeFileSync(join(installDir, 'libexec', 'cli', 'solus.js'), '')

    expect(isManagedVersion(installDir)).toBe(true)
    expect(isManagedVersion(dir)).toBe(false)
  })

  test('verifies the selected release artifact against SHA256SUMS', () => {
    const artifact = join(dir, 'solus.tar.gz')
    writeFileSync(artifact, 'release bytes')
    const digest = createHash('sha256').update('release bytes').digest('hex')
    verifyArchiveSha256(artifact, `${digest}  solus.tar.gz\n`, 'solus.tar.gz')
    expect(() => verifyArchiveSha256(artifact, `${'0'.repeat(64)}  solus.tar.gz\n`, 'solus.tar.gz'))
      .toThrow('Checksum mismatch')
  })
})
