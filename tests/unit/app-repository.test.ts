import { afterAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppRepositories, AppRevisionConflict, type AppFile } from '@solus/server/apps/app-repository'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

actAsHostForTests()
const root = mkdtempSync(join(tmpdir(), 'solus-app-repository-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const repositories = new AppRepositories(() => join(root, 'repositories'))
const AT = Date.parse('2026-11-20T10:00:00.000Z')
/** A name with a space and a letter that is not ASCII, and bytes that are not text. */
const SOURCE: AppFile[] = [
  { path: 'app.ts', bytes: Buffer.from('export default {}\n') },
  { path: 'ui/My icon é.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a]) },
]

function git(gitDir: string, args: string[], options: { input?: Buffer; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync('git', ['--git-dir', gitDir, ...args], { input: options.input, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...options.env } }).trim()
}

// WHY: an app repository is a storage format. A person can clone it, and a
// version record keeps the commit of its revision and of its build. The
// shared commit builder of the Git storage layer must write the same commit
// as the documented one: these files as the whole tree, the author
// `Solus <apps@solus.invalid>`, and the date of the save.
test('a revision is the documented commit, with the app author and the date of the save', async () => {
  const repository = repositories.nameFor('org-a', 'app-1')
  const saved = await repositories.saveRevision(repository, { source: SOURCE, message: 'First revision', at: AT, expected: null })

  const reference = join(root, 'reference.git')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', reference], { stdio: 'ignore' })
  const index = { GIT_INDEX_FILE: join(root, 'reference-index') }
  for (const file of SOURCE) {
    const blob = git(reference, ['hash-object', '-w', '--stdin'], { input: file.bytes })
    git(reference, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`], { env: index })
  }
  const date = new Date(AT).toISOString()
  const expected = git(reference, ['commit-tree', git(reference, ['write-tree'], { env: index }), '-m', 'First revision'], {
    env: {
      GIT_AUTHOR_NAME: 'Solus', GIT_AUTHOR_EMAIL: 'apps@solus.invalid', GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'Solus', GIT_COMMITTER_EMAIL: 'apps@solus.invalid', GIT_COMMITTER_DATE: date,
    },
  })

  expect(saved).toEqual({ commit: expected, parent: null, removed: [] })
  // The name rule is the one from before the shared layer.
  expect(repository).toBe('app-9ebe775507f30ba2b9c1b0d0ce3d39eb830284484af08fcc')
})

// WHY: an app file can be an image, and a person names it. Each read and a
// checkout must give the bytes that the save got, under the same name.
test('a file comes back byte for byte from a read and from a checkout', async () => {
  const repository = repositories.nameFor('org-a', 'app-2')
  const { commit } = await repositories.saveRevision(repository, { source: SOURCE, message: 'First revision', at: AT, expected: null })

  expect(await repositories.listFiles(repository, commit)).toEqual(['app.ts', 'ui/My icon é.png'])
  expect(await repositories.listFiles(repository, commit, 'ui')).toEqual(['ui/My icon é.png'])
  expect(await repositories.readFile(repository, commit, 'ui/My icon é.png')).toEqual(SOURCE[1].bytes)
  expect(await repositories.readFile(repository, commit, 'absent.ts')).toBeNull()
  const folder = join(root, 'checkout')
  expect(await repositories.checkout(repository, commit, folder)).toBe(2)
  expect(readFileSync(join(folder, 'ui', 'My icon é.png'))).toEqual(SOURCE[1].bytes)
})

// WHY: two saves from the same revision must not both win (docs/plans/apps.md
// decision 7), a build must stay off `main`, and the history that a person
// reads must name what each revision changed and removed.
test('a save continues only the newest revision, and a build is not a revision', async () => {
  const repository = repositories.nameFor('org-a', 'app-3')
  const first = await repositories.saveRevision(repository, { source: SOURCE, message: 'First revision', at: AT, expected: null })
  await expect(repositories.saveRevision(repository, { source: SOURCE, message: 'Late', at: AT, expected: null })).rejects.toBeInstanceOf(AppRevisionConflict)
  const second = await repositories.saveRevision(repository, { source: [{ path: 'app.ts', bytes: Buffer.from('export default { name: 1 }\n') }], message: 'Change the app', at: AT + 1000, expected: first.commit })
  const build = await repositories.commitBuild(repository, { number: 1, revision: second.commit, files: [{ path: 'backend.js', bytes: Buffer.from('run()\n') }], at: AT + 2000 })

  expect(second).toMatchObject({ parent: first.commit, removed: ['ui/My icon é.png'] })
  expect(await repositories.parentOf(repository, second.commit)).toBe(first.commit)
  expect(await repositories.parentOf(repository, first.commit)).toBeNull()
  expect(await repositories.hasRevision(repository, second.commit)).toBe(true)
  expect(await repositories.hasRevision(repository, build)).toBe(false)
  expect(await repositories.parentOf(repository, build)).toBe(second.commit)
  expect((await repositories.revisions(repository)).map(({ commit, message, savedAt, stats }) => ({ commit, message, savedAt, stats }))).toEqual([
    { commit: second.commit, message: 'Change the app', savedAt: AT + 1000, stats: { files: 2, additions: 1, deletions: 1 } },
    { commit: first.commit, message: 'First revision', savedAt: AT, stats: { files: 2, additions: 1, deletions: 0 } },
  ])
  const { patch, truncated } = await repositories.diff(repository, first.commit, second.commit)
  expect(patch).toContain('+export default { name: 1 }')
  expect(truncated).toBe(false)
  await expect(repositories.saveRevision(repository, { source: [{ path: '../outside', bytes: Buffer.from('') }], message: 'Bad', at: AT, expected: second.commit })).rejects.toThrow('An app file has a path a repository cannot hold: ../outside')
})
