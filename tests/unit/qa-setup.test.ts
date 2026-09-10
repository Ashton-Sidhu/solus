import { test, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dependenciesReady, dependencyFingerprint } from '../../scripts/qa/setup'

test('workspace additions, deletions and corrupt readiness require setup', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-qa-deps-')))
  try {
    execFileSync('git', ['init', '-q', root])
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.solus-local/\n')
    mkdirSync(join(root, 'node_modules/@solus'), { recursive: true })
    for (const name of ['contracts', 'server', 'client-core', 'workspace-ui']) {
      mkdirSync(join(root, 'packages', name), { recursive: true })
      writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name: `@solus/${name}` }))
      symlinkSync(join(root, 'packages', name), join(root, 'node_modules/@solus', name))
    }
    execFileSync('git', ['add', 'packages'], { cwd: root })
    mkdirSync(join(root, '.solus-local'))
    const marker = join(root, '.solus-local/dependencies.json')
    writeFileSync(marker, JSON.stringify({ worktree: root, fingerprint: dependencyFingerprint(root) }))
    expect(dependenciesReady(root)).toBe(true)
    mkdirSync(join(root, 'packages/new-feature'))
    writeFileSync(join(root, 'packages/new-feature/package.json'), '{"name":"new-feature"}')
    expect(dependenciesReady(root)).toBe(false)
    rmSync(join(root, 'packages/new-feature'), { recursive: true })
    expect(dependenciesReady(root)).toBe(true)
    rmSync(join(root, 'packages/contracts/package.json'))
    expect(dependenciesReady(root)).toBe(false)
    expect(() => dependencyFingerprint(root)).not.toThrow()
    writeFileSync(marker, 'incomplete-json')
    expect(dependenciesReady(root)).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
