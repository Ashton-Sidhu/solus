import { createHash } from 'crypto'
import { readFileSync } from 'fs'

export function verifyArchiveSha256(file: string, sums: string, artifactName: string): void {
  const expected = sums.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === artifactName)?.[0]
  if (!expected) throw new Error(`SHA256SUMS did not contain ${artifactName}`)
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual !== expected) throw new Error(`Checksum mismatch for ${artifactName}`)
}

export { normalizeVersion, compareVersions } from '@solus/contracts/version'
