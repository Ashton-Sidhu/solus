import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type BuildTarget = 'test' | 'production'
export interface BuildIdentity { target: BuildTarget; sourceFingerprint: string; createdAt: string; gitHead?: string; gitBranch?: string }
export function buildDirectory(root: string, target: BuildTarget): string {
  return join(root, target === 'test' ? 'dist/test' : 'dist')
}

export function sourceFingerprint(root: string): string {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter((file) => /^(apps\/|packages\/|scripts\/(?:vite[^/]*$|build-parallel\.sh$|qa\/build-identity[^/]*$)|tests\/e2e\/mock\/|resources\/|patches\/|tools\/|package.json$|bun.lock$|\.oxlint.*$|.*config.*$)/.test(file)).sort()
  const hash = createHash('sha256')
  for (const file of new Set(files)) {
    hash.update(file).update('\0')
    hash.update(existsSync(join(root, file)) ? readFileSync(join(root, file)) : '<deleted>')
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function assertTestBuild(root: string): BuildIdentity {
  const directory = buildDirectory(root, 'test')
  const path = join(directory, 'build-identity.json')
  if (!existsSync(path)) throw new Error('No completed mock build. Run bun run build:test.')
  const identity: BuildIdentity = JSON.parse(readFileSync(path, 'utf8'))
  if (identity.target !== 'test' || identity.sourceFingerprint !== sourceFingerprint(root)) {
    throw new Error('Mock build is stale or has the wrong flavor. Run bun run build:test.')
  }
  for (const file of ['main/index.js', 'main/standalone.js', 'preload/index.js', 'renderer/index.html', 'client/index.html']) {
    if (!existsSync(join(directory, file))) throw new Error(`Mock build is incomplete: ${file}`)
  }
  return identity
}


interface GitRevision { gitHead: string; gitBranch: string }
export function gitRevision(root: string): GitRevision {
  let gitHead = 'unborn'
  let gitBranch = 'detached'
  try { gitHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  try { gitBranch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  return { gitHead, gitBranch }
}

/** The runtime/test harness can change without invalidating compiled app assets. */
export function verificationFingerprint(root: string): string {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'scripts/qa', 'scripts/agent', 'tests/e2e', 'playwright*.ts'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const file of new Set(files)) {
    hash.update(file).update('\0').update(existsSync(join(root, file)) ? readFileSync(join(root, file)) : '<deleted>').update('\0')
  }
  return hash.digest('hex')
}
