import { createHash } from 'crypto'
import { existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'

export function isBrewManaged(installDir: string): boolean {
  return /\/(?:Cellar|homebrew\/Cellar|linuxbrew\/Cellar)\/solus(?:-server)?\//.test(installDir)
}

export function isTarballInstall(installDir: string): boolean {
  return existsSync(join(installDir, 'bin', 'node')) &&
    existsSync(join(installDir, 'libexec', 'server', 'standalone.js')) &&
    existsSync(join(installDir, 'libexec', 'cli', 'solus.js'))
}

export function verifyArchiveSha256(file: string, sums: string, artifactName: string): void {
  const expected = sums.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === artifactName)?.[0]
  if (!expected) throw new Error(`SHA256SUMS did not contain ${artifactName}`)
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual !== expected) throw new Error(`Checksum mismatch for ${artifactName}`)
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, '')
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part.replace(/\D.*$/, '')))
  const right = b.split('.').map((part) => Number(part.replace(/\D.*$/, '')))
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Swap two sibling directories and restore the old install if activation fails. */
export function replaceInstallDirectory(installDir: string, nextDir: string, backupDir: string): void {
  renameSync(installDir, backupDir)
  try {
    renameSync(nextDir, installDir)
  } catch (error) {
    renameSync(backupDir, installDir)
    throw error
  }
}
