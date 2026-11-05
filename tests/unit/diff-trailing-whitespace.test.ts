import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDiff, getEpisodeDiff, initSessionBase, prepareTurnSnapshot, snapshotTurn } from '@solus/server/git/session-snapshots'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

actAsHostForTests()

// The last line of a patch can be a blank context line or an edit that ends in
// spaces. Trimming git's output deletes that line from the patch, so the diff
// shows a change that is not the real one and a strict parser rejects it.
function repoWithTrailingWhitespaceChange() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'solus-diff-whitespace-'))
  dirs.push(repoRoot)
  git(repoRoot, ['init'])
  git(repoRoot, ['config', 'user.email', 'test@example.invalid'])
  git(repoRoot, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoRoot, 'notes.txt'), 'one\ntwo\n\n')
  git(repoRoot, ['add', '.'])
  git(repoRoot, ['commit', '-m', 'base'])
  const change = () => {
    writeFileSync(join(repoRoot, 'notes.txt'), 'one\ntwo  \n\n')
  }
  return { repoRoot, baseSha: git(repoRoot, ['rev-parse', 'HEAD']).trim(), change }
}

function expectWhitespaceKept(patch: string | undefined) {
  expect(patch?.endsWith('-two\n+two  \n \n')).toBe(true)
}

test('the working-tree diff keeps a blank last context line and trailing spaces', async () => {
  const { repoRoot, change } = repoWithTrailingWhitespaceChange()
  change()
  const diff = await getDiff(repoRoot, repoRoot, { kind: 'working-tree' }, null)
  expectWhitespaceKept(diff?.patch)
})

test('the episode diff keeps a blank last context line and trailing spaces', async () => {
  const { repoRoot, baseSha, change } = repoWithTrailingWhitespaceChange()
  change()
  expectWhitespaceKept((await getEpisodeDiff(repoRoot, repoRoot, baseSha)).patch)
})

test('the saved snapshot range diff keeps a blank last context line and trailing spaces', async () => {
  const { repoRoot, baseSha, change } = repoWithTrailingWhitespaceChange()
  await initSessionBase(repoRoot, 'session-ws', baseSha)
  await prepareTurnSnapshot(repoRoot, repoRoot, 'session-ws')
  change()
  await snapshotTurn(repoRoot, repoRoot, 'session-ws', {})
  const diff = await getDiff(null, repoRoot, { kind: 'session' }, 'session-ws')
  expectWhitespaceKept(diff?.patch)
})
