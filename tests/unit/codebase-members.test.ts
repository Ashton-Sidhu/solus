import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Codebase, CodebaseMember } from '@solus/contracts/codebases'
import { DatabaseSync } from './helpers/bun-sqlite'

// The Git process runner loads the host database module, which needs `node:sqlite`.
mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/codebases.md §5 and decision 4: the record of a codebase holds
// roots only. A host reads the members from its disk, so each rule of what a
// member is must hold on real folders and real Git repositories.

const HERE = 'installation-here'
const ELSEWHERE = 'installation-elsewhere'

type MembersModule = typeof import('@solus/server/files/codebase-members')

let sandbox: string
let membersOf: MembersModule['membersOf']
let scanFolder: MembersModule['scanFolder']

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

function folder(...segments: string[]): string {
  const path = join(sandbox, ...segments)
  mkdirSync(path, { recursive: true })
  return path
}

/** A repository with no commit. */
function emptyRepository(...segments: string[]): string {
  const path = folder(...segments)
  git(path, 'init', '-q', '-b', 'main')
  return path
}

/** A repository with one commit. */
function repository(...segments: string[]): string {
  const path = emptyRepository(...segments)
  writeFileSync(join(path, 'README.md'), 'readme\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'first')
  return path
}

const codebaseOf = (...roots: { path: string; installationId?: string; name?: string }[]): Codebase => ({
  id: 'codebase-test',
  name: 'test',
  roots: roots.map((root) => ({ installationId: root.installationId ?? HERE, path: root.path, name: root.name ?? '' })),
  updatedAt: 1,
  deletedAt: null,
})

const pathsOf = (members: CodebaseMember[]): string[] => members.map((member) => member.path)

beforeAll(async () => {
  // The real path: on macOS the temporary directory is a link.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'solus-codebase-members-')))
  const [members, { withHostScope }] = await Promise.all([
    import('@solus/server/files/codebase-members'),
    import('@solus/server/execution/seats/acting-identity'),
  ])
  // A handler runs in the acting scope of its caller; Git starts no process outside one.
  membersOf = (codebase, installationId) => withHostScope(() => members.membersOf(codebase, installationId))
  scanFolder = (path) => withHostScope(() => members.scanFolder(path))
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('the members of a root', () => {
  test('a plain root is a member, and so is each repository one level down', async () => {
    const root = folder('plain-root')
    const api = repository('plain-root', 'api')
    const web = repository('plain-root', 'web')
    folder('plain-root', 'notes')

    const members = await membersOf(codebaseOf({ path: root, name: 'Shop' }), HERE)

    expect(members).toEqual([
      { path: root, name: 'Shop', state: 'plain', repositoryKey: null, rootPath: root, discovered: false, hasCommit: false, submodule: false },
      { path: api, name: 'api', state: 'git', repositoryKey: null, rootPath: root, discovered: true, hasCommit: true, submodule: false },
      { path: web, name: 'web', state: 'git', repositoryKey: null, rootPath: root, discovered: true, hasCommit: true, submodule: false },
    ])
  })

  test('a root that is a repository is a member with its repository key, and a repository nested in it is a member too', async () => {
    const root = repository('git-root')
    git(root, 'remote', 'add', 'origin', 'git@github.com:Acme/Shop.git')
    const nested = repository('git-root', 'vendor-lib')

    const members = await membersOf(codebaseOf({ path: root }), HERE)

    expect(members).toMatchObject([
      { path: root, name: 'git-root', state: 'git', repositoryKey: 'github.com/acme/shop', discovered: false, hasCommit: true },
      { path: nested, state: 'git', repositoryKey: null, discovered: true, rootPath: root },
    ])
  })

  test('a repository inside a plain wrapper folder is found', async () => {
    // WHY: `packages/x` and `src/x` are the usual places of the repositories of one piece of work.
    const root = folder('wrapper-root')
    const inWrapper = repository('wrapper-root', 'packages', 'x')

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root, inWrapper])
  })

  test('nothing is found three levels down', async () => {
    // WHY: the read of a root must stay small, also for a root such as the home folder.
    const root = folder('deep-root')
    repository('deep-root', 'a', 'b', 'too-deep')

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root])
  })

  test('the inside of a repository that was found is not read', async () => {
    const root = folder('stop-root')
    const outer = repository('stop-root', 'outer')
    repository('stop-root', 'outer', 'inner')

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root, outer])
  })

  test('dot-folders and node_modules are not read', async () => {
    const root = folder('skip-root')
    repository('skip-root', '.cache', 'tool')
    repository('skip-root', 'node_modules', 'dependency')
    repository('skip-root', '.hidden')

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root])
  })

  test('a repository with no commit is a member that cannot get a worktree', async () => {
    const root = folder('unborn-root')
    const unborn = emptyRepository('unborn-root', 'fresh')

    expect(await membersOf(codebaseOf({ path: root }), HERE)).toMatchObject([
      { path: root },
      { path: unborn, state: 'git', hasCommit: false },
    ])
  })
})

describe('checkouts that follow a different repository', () => {
  test('a submodule is not found as a member of its own', async () => {
    const library = repository('submodule-source')
    const root = repository('submodule-root')
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'libs/shared')
    git(root, 'commit', '-q', '-m', 'add submodule')

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root])
  })

  test('a submodule that a person made a root is a member that follows its parent', async () => {
    // WHY: stage 3 never gives a submodule its own worktree; the mark tells it which members those are.
    const library = repository('submodule-source-2')
    const parent = repository('submodule-parent')
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'libs/shared')
    const submodule = join(parent, 'libs', 'shared')

    expect(await membersOf(codebaseOf({ path: submodule }), HERE)).toMatchObject([
      { path: submodule, state: 'git', submodule: true, discovered: false },
    ])
  })

  test('a linked worktree is not found as a member of its own', async () => {
    const root = folder('worktree-root')
    const main = repository('worktree-root', 'main-checkout')
    git(main, 'worktree', 'add', '-q', '-b', 'feature', join(root, 'feature-checkout'))

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root, main])
  })
})

describe('ignoreRepositories', () => {
  test('a path in the config of the root is not a member, and neither is a repository below it', async () => {
    const root = folder('ignore-root')
    const kept = repository('ignore-root', 'kept')
    repository('ignore-root', 'ignored')
    repository('ignore-root', 'packages', 'generated')
    repository('ignore-root', 'archive', 'old')
    const alsoKept = repository('ignore-root', 'packages', 'kept-too')
    mkdirSync(join(root, '.solus'))
    writeFileSync(join(root, '.solus', 'config.json'), JSON.stringify({ version: 1, ignoreRepositories: ['ignored', './packages/generated/', 'archive'] }))

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root, kept, alsoKept])
  })

  test('a config that cannot be read ignores nothing', async () => {
    const root = folder('bad-config-root')
    const repo = repository('bad-config-root', 'repo')
    mkdirSync(join(root, '.solus'))
    writeFileSync(join(root, '.solus', 'config.json'), '{ not json')

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root, repo])
  })
})

describe('symbolic links', () => {
  test('a link that resolves outside the root is not a member', async () => {
    // WHY: a member is granted to the agent. A link must not grant a folder that the person did not put in the codebase.
    const root = folder('link-root')
    const outside = repository('link-outside')
    symlinkSync(outside, join(root, 'escape'))
    const outsideWrapper = folder('link-outside-wrapper')
    repository('link-outside-wrapper', 'hidden')
    symlinkSync(outsideWrapper, join(root, 'wrapper'))

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root])
  })

  test('a link to a repository inside the root does not make a second member', async () => {
    const root = folder('link-inside-root')
    const api = repository('link-inside-root', 'api')
    symlinkSync(api, join(root, 'api-link'))

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root, api])
  })
})

describe('roots', () => {
  test('a root that is not on the disk is a member of state missing', async () => {
    const gone = join(sandbox, 'never-made')

    expect(await membersOf(codebaseOf({ path: gone }), HERE)).toEqual([
      { path: gone, name: 'never-made', state: 'missing', repositoryKey: null, rootPath: gone, discovered: false, hasCommit: false, submodule: false },
    ])
  })

  test('a root that is a file is missing', async () => {
    const root = folder('file-root')
    const file = join(root, 'notes.txt')
    writeFileSync(file, 'notes\n')

    expect(await membersOf(codebaseOf({ path: file }), HERE)).toMatchObject([{ path: file, state: 'missing' }])
  })

  test('a root on a different host is not read and is not in the answer', async () => {
    // WHY: decision 3. The same path can exist on this host and be a different
    // folder; only the host that the root names answers for it.
    const here = repository('host-here')
    const elsewhere = repository('host-elsewhere')

    const members = await membersOf(codebaseOf({ path: here }, { path: elsewhere, installationId: ELSEWHERE }), HERE)

    expect(pathsOf(members)).toEqual([here])
    expect(await membersOf(codebaseOf({ path: elsewhere, installationId: ELSEWHERE }), HERE)).toEqual([])
  })

  test('a root inside a different root is one member: the root', async () => {
    const outer = folder('overlap-root')
    const inner = repository('overlap-root', 'api')

    const members = await membersOf(codebaseOf({ path: outer }, { path: inner, name: 'API' }), HERE)

    expect(members).toMatchObject([
      { path: outer, discovered: false },
      { path: inner, name: 'API', discovered: false, rootPath: inner },
    ])
  })
})

describe('the scan of one folder', () => {
  test('answers the same members a root at that path gives', async () => {
    const root = folder('scan-root')
    const api = repository('scan-root', 'api')

    const scan = await scanFolder(root)

    expect(scan).toMatchObject({ path: root, state: 'plain', suggestions: [] })
    expect(scan.members).toEqual(await membersOf(codebaseOf({ path: root }), HERE))
    expect(pathsOf(scan.members)).toEqual([root, api])
  })

  test('a folder that is not there is missing', async () => {
    const gone = join(sandbox, 'scan-gone')
    expect(await scanFolder(gone)).toMatchObject({ path: gone, state: 'missing', suggestions: [] })
  })

  test('the folders of a .code-workspace file are suggestions and never members', async () => {
    // WHY: a workspace file can list any folder of the disk. A person adds one with a click; Solus does not add it.
    const root = repository('workspace-root')
    const inside = repository('workspace-root', 'inside')
    const sibling = repository('workspace-sibling')
    const named = folder('workspace-named')
    writeFileSync(join(root, 'shop.code-workspace'), `{
      // The editor allows comments and trailing commas in this file.
      "folders": [
        { "path": "." },
        { "path": "inside" },
        { "path": "../workspace-sibling" },
        { "path": "../workspace-named", "name": "Design notes" },
        { "path": "../workspace-not-there" },
        { "uri": "vscode-remote://host/path" },
      ],
    }`)

    const scan = await scanFolder(root)

    expect(scan.suggestions).toEqual([
      { path: named, name: 'Design notes' },
      { path: sibling, name: 'workspace-sibling' },
    ])
    expect(pathsOf(scan.members)).toEqual([root, inside])
  })
})
