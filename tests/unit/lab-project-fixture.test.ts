import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { test, expect } from 'bun:test'
import { join } from 'node:path'
import { projectFixture } from '../../packages/lab/src/project-fixture'

test('the Lab gives two hosts independent clones of one Git origin', () => {
  // WHY: portable session code restore must read a real Git tree from each host checkout.
  const project = projectFixture()
  try {
    const a = project.clone('a')
    const b = project.clone('b')
    const head = (cwd: string) => execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(head(a)).toBe(head(b))
    expect(readFileSync(join(a, 'note.txt'), 'utf8')).toBe('initial\n')
    expect(existsSync(join(project.origin, 'HEAD'))).toBe(true)
  } finally { project.stop() }
})
