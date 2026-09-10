import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readGuidePatchAt, readGuideFileContentsAt } from '@solus/server/review/pr-guide-diff'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('a saved guide reads its recorded commits after the checkout changes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'solus-guide-diff-'))
  roots.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  writeFileSync(join(cwd, 'fix.txt'), 'before\n\n')
  git('add', '.')
  git('commit', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  writeFileSync(join(cwd, 'fix.txt'), 'saved guide change\n\n')
  git('add', '.')
  git('commit', '-m', 'guide head')
  const headSha = git('rev-parse', 'HEAD')
  writeFileSync(join(cwd, 'fix.txt'), 'newer PR change\n')
  writeFileSync(join(cwd, 'unrelated.txt'), 'active session change\n')
  const request = { number: 7, baseSha, headSha }
  const diff = await readGuidePatchAt(cwd, request)
  expect(diff.patch).toContain('+saved guide change')
  expect(diff.patch).not.toContain('newer PR change')
  expect(diff.patch).not.toContain('unrelated.txt')
  const contents = await readGuideFileContentsAt(cwd, {
    ...request, oldPath: 'fix.txt', newPath: 'fix.txt', changeType: 'change',
  })
  expect(contents).toEqual({ oldContents: 'before\n\n', newContents: 'saved guide change\n\n' })
})
