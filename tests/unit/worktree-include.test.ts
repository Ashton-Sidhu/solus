import { afterEach, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The host's git probe asks `xcode-select`, which a sandbox can refuse. These
// tests make their own repositories with the git on PATH.
const gitAvailability = await import('@solus/server/git/git-availability')
mock.module('@solus/server/git/git-availability', () => ({ ...gitAvailability, isGitUsable: () => true }))
const {
  listIgnoredProjectFiles,
  readWorktreeIncludedFiles,
  setWorktreeIncluded,
  withAppendedLines,
  withoutOpposingLines,
  writeMissingCopiedFiles,
} = await import('@solus/server/git/worktree-include')
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
actAsHostForTests()

const roots: string[] = []

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'solus-worktree-include-'))
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function included(root: string): Promise<string[]> {
  return listIgnoredProjectFiles(root).then((list) => list.files.filter((file) => file.included).map((file) => file.path))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the .worktreeinclude a checkbox edits', () => {
  test('only ignored files are listed, and a folder git ignores whole is left out', async () => {
    // WHY: a tracked file reaches the clone through git already, and nobody
    // copies node_modules by hand. The list is what a person would choose from.
    const root = repo({
      '.gitignore': '.env*\nnode_modules/\n',
      '.env': 'A=1',
      'node_modules/pkg/index.js': 'x',
      'src/app.ts': 'tracked',
    })
    const list = await listIgnoredProjectFiles(root)
    expect(list.files.map((file) => file.path)).toEqual(['.env'])
    expect(list.hasIncludeFile).toBe(false)
  })

  test('checking a file adds one line; unchecking it takes that line out again', async () => {
    // WHY: the file is the person's own, maybe committed. A round trip must
    // leave it as it was, not grow a line on every click.
    const root = repo({ '.gitignore': '.env*\n', '.env': 'A=1', '.env.local': 'B=2' })
    await setWorktreeIncluded(root, [{ path: '.env', included: true }])
    expect(await included(root)).toEqual(['.env'])
    expect(readFileSync(join(root, '.worktreeinclude'), 'utf-8')).toBe('/.env\n')

    await setWorktreeIncluded(root, [{ path: '.env', included: false }])
    expect(await included(root)).toEqual([])
    expect(readFileSync(join(root, '.worktreeinclude'), 'utf-8')).toBe('')
  })

  test('a pattern keeps its meaning, and unchecking one file it matches adds an exception', async () => {
    // WHY: rewriting `.env*` into a list of today's files would silently stop
    // including tomorrow's. Only the one file the person unchecked changes.
    const root = repo({ '.gitignore': '.env*\n', '.env': 'A=1', '.env.local': 'B=2', '.worktreeinclude': '.env*\n' })
    await setWorktreeIncluded(root, [{ path: '.env.local', included: false }])
    expect(await included(root)).toEqual(['.env'])
    expect(readFileSync(join(root, '.worktreeinclude'), 'utf-8')).toBe('.env*\n!/.env.local\n')

    await setWorktreeIncluded(root, [{ path: '.env.local', included: true }])
    expect(await included(root)).toEqual(['.env', '.env.local'])
    expect(readFileSync(join(root, '.worktreeinclude'), 'utf-8')).toBe('.env*\n')
  })

  test('the line helpers touch only exact lines for the changed paths', () => {
    expect(withoutOpposingLines('.env*\n/.env\n# keep\n', [{ path: '.env', included: false }])).toBe('.env*\n# keep\n')
    expect(withoutOpposingLines('!/.env\n!.env\n.env\n', [{ path: '.env', included: true }])).toBe('.env\n')
    expect(withAppendedLines('a', ['/b'])).toBe('a\n/b\n')
  })
})

describe('the files a Run on send copies', () => {
  test('a send carries the included files and the .worktreeinclude, and nothing else', async () => {
    // WHY: the other host's later worktrees copy from the clone's own
    // .worktreeinclude, so it must arrive with the files it names.
    const root = repo({ '.gitignore': '.env*\n.worktreeinclude\nsecret.key\n', '.env': 'A=1', 'secret.key': 'no', '.worktreeinclude': '.env\n' })
    const files = await readWorktreeIncludedFiles(root)
    expect(files.map((file) => file.path).sort()).toEqual(['.env', '.worktreeinclude'])
    expect(Buffer.from(files.find((file) => file.path === '.env')!.contentBase64, 'base64').toString()).toBe('A=1')
  })

  test('a project with no .worktreeinclude sends no files', async () => {
    const root = repo({ '.gitignore': '.env\n', '.env': 'A=1' })
    expect(await readWorktreeIncludedFiles(root)).toEqual([])
  })

  test('the clone keeps a file it already has', async () => {
    // WHY: the agent, or a person, may have changed .env on that host. A later
    // send must not put the home copy back over it.
    const target = repo({ '.env': 'changed-there' })
    const written = await writeMissingCopiedFiles(target, [
      { path: '.env', contentBase64: Buffer.from('home').toString('base64') },
      { path: 'apps/site/.dev.vars', contentBase64: Buffer.from('V=1').toString('base64') },
    ])
    expect(written).toBe(1)
    expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('changed-there')
    expect(readFileSync(join(target, 'apps/site/.dev.vars'), 'utf-8')).toBe('V=1')
  })

  test('a path from the client cannot leave the checkout or reach into .git', async () => {
    // WHY: the paths arrive over the network. A host must not write where the
    // sender names outside the checkout, or plant a git hook.
    const target = repo({})
    const outside = mkdtempSync(join(tmpdir(), 'solus-worktree-include-outside-'))
    roots.push(outside)
    symlinkSync(outside, join(target, 'linked'))
    const file = (path: string) => [{ path, contentBase64: Buffer.from('x').toString('base64') }]

    await expect(writeMissingCopiedFiles(target, file('../escape'))).rejects.toThrow()
    await expect(writeMissingCopiedFiles(target, file('.git/hooks/pre-commit'))).rejects.toThrow()
    await expect(writeMissingCopiedFiles(target, file('linked/planted'))).rejects.toThrow()
    expect(existsSync(join(outside, 'planted'))).toBe(false)
    expect(existsSync(join(target, '.git/hooks/pre-commit'))).toBe(false)
  })
})
