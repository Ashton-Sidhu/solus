import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verificationFingerprint } from './build-identity'
import type { RunManifest } from './runner'

interface ValidationEvidence {
  generationId: string
  sourceFingerprint: string
  test?: string
  project?: string
  status?: string
  provider?: string
  finishedAt?: string
}
interface MissingEvidence { behavioral: 'not run' | 'stale'; visual: 'not run'; native: 'not run' }
export function validationFor(run: RunManifest): ValidationEvidence | MissingEvidence {
  const path = join(run.directory, 'validation.json')
  if (!existsSync(path)) return { behavioral: 'not run', visual: 'not run', native: 'not run' }
  const validation: ValidationEvidence = JSON.parse(readFileSync(path, 'utf8'))
  if (validation.generationId !== run.generationId || validation.sourceFingerprint !== run.sourceFingerprint || verificationFingerprint(run.worktree) !== run.verificationFingerprint) {
    return { behavioral: 'stale', visual: 'not run', native: 'not run' }
  }
  return validation
}
