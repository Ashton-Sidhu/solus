import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface DependencyState { fingerprint: string; bunVersion: string; worktree: string }
export function dependencyFingerprint(root: string): string {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'package.json', 'bun.lock', 'apps/*/package.json', 'packages/*/package.json', 'patches'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update(existsSync(join(root, file)) ? readFileSync(join(root, file)) : '<deleted>')
  hash.update(execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim())
  return hash.digest('hex')
}
export function dependenciesReady(root: string): boolean {
  const path = join(root, '.solus-local/dependencies.json')
  if (!existsSync(path) || !existsSync(join(root, 'node_modules'))) return false
  try {
    const state: DependencyState = JSON.parse(readFileSync(path, 'utf8'))
    if (state.worktree !== realpathSync(root) || state.fingerprint !== dependencyFingerprint(root)) return false
    for (const name of ['contracts', 'server', 'client-core', 'workspace-ui']) {
      const linked = join(root, 'node_modules/@solus', name)
      if (!existsSync(linked) || realpathSync(linked) !== realpathSync(join(root, 'packages', name))) return false
    }
    return true
  } catch { return false }
}
export function setup(root: string): void {
  const stateDirectory = join(root, '.solus-local')
  if (existsSync(stateDirectory) && realpathSync(stateDirectory) !== stateDirectory) throw new Error('QA setup state directory must not be a symlink')
  const modules = join(root, 'node_modules')
  if (existsSync(modules) && realpathSync(modules) !== modules) throw new Error('node_modules is a symlink. Use a local dependency install; do not modify shared dependencies.')
  execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'inherit' })
  mkdirSync(join(root, '.solus-local'), { recursive: true })
  const state: DependencyState = { fingerprint: dependencyFingerprint(root), bunVersion: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(), worktree: realpathSync(root) }
  writeFileSync(join(root, '.solus-local/dependencies.json'), JSON.stringify(state, null, 2))
  if (!dependenciesReady(root)) throw new Error('Workspace packages resolve outside this worktree; setup is incomplete')
}
