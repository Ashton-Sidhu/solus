import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePatch } from '@solus/server/git/interdiff'
import { normalizeGuide } from '@solus/server/review/review-guide-tool'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

// Git writes a name with a quote, a backslash, a tab, or (with core.quotePath)
// a non-ASCII character in C-style quotes. The review guide matches the
// agent's paths against the parsed patch, so a name left encoded drops the
// file's section from the guide.
const NAMES = ['say "hi".ts', 'back\\slash.ts', 'tab\there.ts', 'café.ts']

function patchWithEscapedNames(quotePath: boolean): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'solus-quoted-paths-'))
  dirs.push(repoRoot)
  git(repoRoot, ['init'])
  git(repoRoot, ['config', 'user.email', 'test@example.invalid'])
  git(repoRoot, ['config', 'user.name', 'Test'])
  for (const name of NAMES) writeFileSync(join(repoRoot, name), 'one\n')
  git(repoRoot, ['add', '.'])
  git(repoRoot, ['commit', '-m', 'base'])
  for (const name of NAMES) writeFileSync(join(repoRoot, name), 'two\n')
  // An empty new file has no ---/+++ lines; only its diff --git line names it.
  writeFileSync(join(repoRoot, 'empty "new".ts'), '')
  git(repoRoot, ['add', '-N', 'empty "new".ts'])
  return git(repoRoot, ['-c', `core.quotepath=${quotePath}`, 'diff', 'HEAD'])
}

for (const quotePath of [true, false]) {
  test(`parsed patch paths are the real file names (core.quotePath=${quotePath})`, () => {
    const patch = patchWithEscapedNames(quotePath)
    if (quotePath) expect(patch).toContain('\\303\\251')
    expect(parsePatch(patch).map((file) => file.filePath).sort()).toEqual([...NAMES, 'empty "new".ts'].sort())
  })
}

test('a guide section that names an escaped file keeps its excerpt', () => {
  const patch = patchWithEscapedNames(true)
  const guide = normalizeGuide({
    title: 'Names',
    summary: 'Edits files with escaped names.',
    sections: [{
      id: 'names',
      title: 'Names',
      significance: 'core',
      summary: 'Every file.',
      files: NAMES.map((path) => ({ path, ranges: [{ side: 'new' as const, start: 1, end: 1 }] })),
    }],
  }, { patch })

  const files = guide.sections.find((section) => section.id === 'names')?.files ?? []
  expect(files.map((file) => file.path)).toEqual(NAMES)
  for (const file of files) expect(file).toMatchObject({ additions: 1, deletions: 1 })
})
