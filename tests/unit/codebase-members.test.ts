import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Codebase, CodebaseMember } from '@solus/contracts/codebases'
import { DatabaseSync } from './helpers/bun-sqlite'

// The Git process runner loads the host database module, which needs `node:sqlite`.
mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/codebases.md §5 and decisions 4 and 14: the record of a codebase
// holds roots only. A host reads the members from its disk, so each rule of
// what a member is must hold on real folders and real Git repositories. A
// root that is a container gives the repositories inside it. A root with no
// such mark is one project: one member.

const HERE = 'installation-here'
const ELSEWHERE = 'installation-elsewhere'

type MembersModule = typeof import('@solus/server/files/codebase-members')

let sandbox: string
let membersOf: MembersModule['membersOf']
let scanFolder: MembersModule['scanFolder']
let isContainer: MembersModule['isContainer']

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

const codebaseOf = (...roots: { path: string; installationId?: string; name?: string; container?: true }[]): Codebase => ({
  id: 'codebase-test',
  name: 'test',
  roots: roots.map((root) => ({ installationId: root.installationId ?? HERE, path: root.path, name: root.name ?? '', ...(root.container ? { container: true as const } : {}) })),
  updatedAt: 1,
  deletedAt: null,
})

/** A codebase of one container root: the host reads the repositories inside it. */
const containerOf = (path: string, name?: string): Codebase => codebaseOf({ path, name, container: true })

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
  isContainer = (path) => withHostScope(() => members.isContainer(path))
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('the members of a container root', () => {
  test('the container is a member, and so is each repository one level down', async () => {
    const root = folder('plain-root')
    const api = repository('plain-root', 'api')
    const web = repository('plain-root', 'web')
    folder('plain-root', 'notes')

    const members = await membersOf(containerOf(root, 'Shop'), HERE)

    expect(members).toEqual([
      { path: root, name: 'Shop', state: 'plain', repositoryKey: null, rootPath: root, discovered: false, hasCommit: false, submodule: false },
      { path: api, name: 'api', state: 'git', repositoryKey: null, rootPath: root, discovered: true, hasCommit: true, submodule: false },
      { path: web, name: 'web', state: 'git', repositoryKey: null, rootPath: root, discovered: true, hasCommit: true, submodule: false },
    ])
  })

  test('a repository that is cloned into the container later is a member on the next read', async () => {
    // WHY: the record holds the root only, so a person does not edit the codebase after a clone.
    const root = folder('grow-root')
    const api = repository('grow-root', 'api')
    const web = repository('grow-root', 'web')
    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root, api, web])

    const docs = repository('grow-root', 'docs')

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root, api, docs, web])
  })

  test('a repository inside a plain wrapper folder is found', async () => {
    // WHY: `packages/x` and `src/x` are the usual places of the repositories of one piece of work.
    const root = folder('wrapper-root')
    const inWrapper = repository('wrapper-root', 'packages', 'x')

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root, inWrapper])
  })

  test('nothing is found three levels down', async () => {
    // WHY: the read of a root must stay small, also for a root such as the home folder.
    const root = folder('deep-root')
    repository('deep-root', 'a', 'b', 'too-deep')

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root])
  })

  test('the inside of a repository that was found is not read', async () => {
    const root = folder('stop-root')
    const outer = repository('stop-root', 'outer')
    repository('stop-root', 'outer', 'inner')

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root, outer])
  })

  test('dot-folders and node_modules are not read', async () => {
    const root = folder('skip-root')
    repository('skip-root', '.cache', 'tool')
    repository('skip-root', 'node_modules', 'dependency')
    repository('skip-root', '.hidden')

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root])
  })

  test('a repository with no commit is a member that cannot get a worktree', async () => {
    const root = folder('unborn-root')
    const unborn = emptyRepository('unborn-root', 'fresh')

    expect(await membersOf(containerOf(root), HERE)).toMatchObject([
      { path: root },
      { path: unborn, state: 'git', hasCommit: false },
    ])
  })
})

describe('checkouts that follow a different repository', () => {
  test('a submodule is not found as a member of its own', async () => {
    const library = repository('submodule-source')
    const root = folder('submodule-root')
    const parent = repository('submodule-root', 'parent')
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'libs/shared')
    git(parent, 'commit', '-q', '-m', 'add submodule')

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root, parent])
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

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root, main])
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

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root, kept, alsoKept])
  })

  test('a config that cannot be read ignores nothing', async () => {
    const root = folder('bad-config-root')
    const repo = repository('bad-config-root', 'repo')
    mkdirSync(join(root, '.solus'))
    writeFileSync(join(root, '.solus', 'config.json'), '{ not json')

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root, repo])
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

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root])
  })

  test('a link to a repository inside the root does not make a second member', async () => {
    const root = folder('link-inside-root')
    const api = repository('link-inside-root', 'api')
    symlinkSync(api, join(root, 'api-link'))

    expect(pathsOf(await membersOf(containerOf(root), HERE))).toEqual([root, api])
  })
})

describe('a root that is one project', () => {
  test('a repository root is one member with its repository key: the host does not look inside it', async () => {
    // WHY: a project is one folder or one repository (decision 14). A repository nested in it is a part of that project.
    const root = repository('git-root')
    git(root, 'remote', 'add', 'origin', 'git@github.com:Acme/Shop.git')
    repository('git-root', 'vendor-lib')

    expect(await membersOf(codebaseOf({ path: root }), HERE)).toMatchObject([
      { path: root, name: 'git-root', state: 'git', repositoryKey: 'github.com/acme/shop', discovered: false, hasCommit: true },
    ])
  })

  test('a plain root with no container mark is one member, also when it holds repositories', async () => {
    const root = folder('unmarked-root')
    repository('unmarked-root', 'api')
    repository('unmarked-root', 'web')

    expect(pathsOf(await membersOf(codebaseOf({ path: root }), HERE))).toEqual([root])
  })
})

describe('a container', () => {
  test('a folder with no repository of its own that holds two repositories is a container', async () => {
    const root = folder('container-two')
    repository('container-two', 'api')
    repository('container-two', 'packages', 'web')

    expect(await isContainer(root)).toBe(true)
  })

  test('a folder that holds one repository or none is a project, and so is a repository', async () => {
    // WHY: one repository in a folder is one piece of code. Such a folder stays a normal project.
    const one = folder('container-one')
    repository('container-one', 'api')
    const none = folder('container-none')
    const itself = repository('container-itself')
    repository('container-itself', 'a')
    repository('container-itself', 'b')

    expect(await isContainer(one)).toBe(false)
    expect(await isContainer(none)).toBe(false)
    expect(await isContainer(itself)).toBe(false)
    expect(await isContainer(join(sandbox, 'container-gone'))).toBe(false)
  })

  test('an ignored repository does not count', async () => {
    const root = folder('container-ignored')
    repository('container-ignored', 'api')
    repository('container-ignored', 'archive')
    mkdirSync(join(root, '.solus'))
    writeFileSync(join(root, '.solus', 'config.json'), JSON.stringify({ version: 1, ignoreRepositories: ['archive'] }))

    expect(await isContainer(root)).toBe(false)
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

    const members = await membersOf(codebaseOf({ path: outer, container: true }, { path: inner, name: 'API' }), HERE)

    expect(members).toMatchObject([
      { path: outer, discovered: false },
      { path: inner, name: 'API', discovered: false, rootPath: inner },
    ])
  })
})

describe('the scan of one folder', () => {
  test('answers the same members a container root at that path gives', async () => {
    const root = folder('scan-root')
    const api = repository('scan-root', 'api')

    const scan = await scanFolder(root)

    expect(scan).toMatchObject({ path: root, state: 'plain', suggestions: [] })
    expect(scan.members).toEqual(await membersOf(containerOf(root), HERE))
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
