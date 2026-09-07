import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildDirectory, sourceFingerprint, gitRevision, type BuildIdentity } from './build-identity'
{
  const root = process.cwd()
  const target = process.env.BUILD_TARGET === 'test' ? 'test' : 'production'
  const directory = buildDirectory(root, target)
  const path = join(directory, 'build-identity.json')
  mkdirSync(directory, { recursive: true })
  if (process.argv[2] === 'begin') {
    rmSync(path, { force: true })
    writeFileSync(join(directory, '.source-start'), sourceFingerprint(root))
  } else {
    const fingerprint = sourceFingerprint(root)
    if (readFileSync(join(directory, '.source-start'), 'utf8') !== fingerprint) throw new Error('Source changed during build; rebuild before QA.')
    writeFileSync(path, JSON.stringify({ target, ...gitRevision(root), sourceFingerprint: fingerprint, createdAt: new Date().toISOString() } satisfies BuildIdentity, null, 2))
  }
}
