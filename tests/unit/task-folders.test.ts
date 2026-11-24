import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CODEBASE_WORKTREE_DEFAULT_MAX, isTaskFolderPath, TASK_FOLDER_ROOT_NAME, type Codebase, type CodebaseMember, type TaskFolder } from '@solus/contracts/codebases'
import type { TaskFolderPlan } from '@solus/server/git/task-folders'
import { DatabaseSync } from './helpers/bun-sqlite'

// The Git process runner and the record of a task folder use the host database module, which needs `node:sqlite`.
mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/codebases.md §7: a worktree session of several repositories works
// in a task folder, one directory that holds a worktree of each chosen
// repository at the same relative place as the original. Each rule here is
// about real folders and real Git repositories, so the tests make them.

type TaskFoldersModule = typeof import('@solus/server/git/task-folders')
type StoreModule = typeof import('@solus/server/git/task-folder-store')
type MembersModule = typeof import('@solus/server/files/codebase-members')
type DbModule = typeof import('@solus/server/db')

const HERE = 'installation-here'
const LONG = 60_000

let sandbox: string
let dataDir: string
let taskFolders: TaskFoldersModule
let store: StoreModule
let members: MembersModule
let db: DbModule
/** A handler runs in the acting scope of its caller; Git starts no process outside one. */
let asHost: <T>(run: () => T) => T
const previousEnv = { dataDir: process.env.SOLUS_DATA_DIR, globalConfig: process.env.GIT_CONFIG_GLOBAL, systemConfig: process.env.GIT_CONFIG_SYSTEM }

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

function folder(...segments: string[]): string {
  const path = join(sandbox, ...segments)
  mkdirSync(path, { recursive: true })
  return path
}

/** A repository with one commit on `main`. */
function repository(...segments: string[]): string {
  const path = folder(...segments)
  git(path, 'init', '-q', '-b', 'main')
  writeFileSync(join(path, 'README.md'), 'readme\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'first')
  return path
}

function commit(repositoryPath: string, file: string, message: string): string {
  writeFileSync(join(repositoryPath, file), `${message}\n`)
  git(repositoryPath, 'add', '.')
  git(repositoryPath, 'commit', '-q', '-m', message)
  return git(repositoryPath, 'rev-parse', 'HEAD')
}

const branchOf = (checkout: string): string => git(checkout, 'rev-parse', '--abbrev-ref', 'HEAD')
const headOf = (checkout: string): string => git(checkout, 'rev-parse', 'HEAD')
const branchesOf = (repositoryPath: string): string[] => git(repositoryPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean)
const worktreeCountOf = (repositoryPath: string): number => git(repositoryPath, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length
const isLink = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
/** A linked worktree has a `.git` file; a repository and a clone have a `.git` directory. */
const isLinkedWorktree = (path: string): boolean => lstatSync(join(path, '.git'), { throwIfNoEntry: false })?.isFile() ?? false

/** A member as discovery reports it, for the plan, which reads no disk. */
function member(path: string, overrides: Partial<CodebaseMember> = {}): CodebaseMember {
  return { path, name: path.split(/[\\/]/).at(-1) ?? path, state: 'git', repositoryKey: null, rootPath: path, discovered: false, hasCommit: true, submodule: false, ...overrides }
}

/**
 * The members of a codebase with these roots, read from the disk. A root
 * with no repository of its own is a container root, so the repositories
 * inside it are members. A repository root is one project: one member.
 */
function membersOfRoots(...roots: string[]): Promise<CodebaseMember[]> {
  const codebase: Codebase = {
    id: 'codebase-test', name: 'test', updatedAt: 1, deletedAt: null,
    roots: roots.map((path) => ({ installationId: HERE, path, name: '', ...(existsSync(join(path, '.git')) ? {} : { container: true as const }) })),
  }
  return asHost(() => members.membersOf(codebase, HERE))
}

interface Shop {
  shop: string
  api: string
  web: string
}

/** A plain folder `shop` with the repositories `api` and `web` and a file. */
function shopAt(name: string): Shop {
  const shop = folder(name, 'shop')
  writeFileSync(join(shop, 'README.md'), 'the shop\n')
  return { shop, api: repository(name, 'shop', 'api'), web: repository(name, 'shop', 'web') }
}

async function createFor(workingMember: string, roots: string[], options: { branch: string; baseBranch?: string | null; repositories?: string[] | null }): Promise<TaskFolder> {
  const plan = taskFolders.planTaskFolder({ codebaseId: 'codebase-test', workingMember, members: await membersOfRoots(...roots), repositories: options.repositories ?? null })
  if (!plan) throw new Error('The test expected a task folder plan.')
  const { taskFolder } = await asHost(() => taskFolders.createTaskFolder(plan, { baseFolder: dataDir, branch: options.branch, baseBranch: options.baseBranch ?? null }))
  return taskFolder
}

beforeAll(async () => {
  // The real path: on macOS the temporary directory is a link.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'solus-task-folders-')))
  dataDir = join(sandbox, 'data')
  mkdirSync(dataDir)
  process.env.SOLUS_DATA_DIR = dataDir
  // The module's Git must not read the configuration of the person who runs the tests.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  const [loadedTaskFolders, loadedStore, loadedMembers, loadedDb, { withHostScope }] = await Promise.all([
    import('@solus/server/git/task-folders'),
    import('@solus/server/git/task-folder-store'),
    import('@solus/server/files/codebase-members'),
    import('@solus/server/db'),
    import('@solus/server/execution/seats/acting-identity'),
  ])
  taskFolders = loadedTaskFolders
  store = loadedStore
  members = loadedMembers
  db = loadedDb
  asHost = withHostScope
})

afterAll(() => {
  db.closeDb()
  rmSync(sandbox, { recursive: true, force: true })
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  restore('SOLUS_DATA_DIR', previousEnv.dataDir)
  restore('GIT_CONFIG_GLOBAL', previousEnv.globalConfig)
  restore('GIT_CONFIG_SYSTEM', previousEnv.systemConfig)
})

describe('the plan of a task folder', () => {
  const plan = (workingMember: string, all: CodebaseMember[], repositories: string[] | null = null) =>
    taskFolders.planTaskFolder({ codebaseId: 'codebase-shop', workingMember, members: all, repositories })

  test('without a choice, each repository of a plain working member gets a worktree', () => {
    const all = [member('/code/shop', { state: 'plain', hasCommit: false }), member('/code/shop/api'), member('/code/shop/web')]

    expect(plan('/code/shop', all)).toEqual({
      codebaseId: 'codebase-shop',
      anchor: '/code/shop',
      workingMember: '/code/shop',
      workingMemberIsRepository: false,
      repositories: [{ path: '/code/shop/api', name: 'api' }, { path: '/code/shop/web', name: 'web' }],
      otherRepositories: [],
    })
  })

  test('above the limit, no repository gets a worktree without a choice', () => {
    // WHY: a session of a large codebase must not write tens of working trees that nobody asked for.
    const others = Array.from({ length: CODEBASE_WORKTREE_DEFAULT_MAX }, (_, index) => member(`/code/r${index}`))
    const atLimit = [member('/code/main'), ...others.slice(1)]
    const aboveLimit = [member('/code/main'), ...others]

    expect(plan('/code/main', atLimit)?.repositories).toHaveLength(CODEBASE_WORKTREE_DEFAULT_MAX - 1)
    // The working member is a repository and it is alone, so today's worktree inside it is enough.
    expect(plan('/code/main', aboveLimit)).toBeNull()
    expect(plan('/code/notes', [member('/code/notes', { state: 'plain' }), ...others, member('/code/r-more')])).toMatchObject({
      repositories: [],
      otherRepositories: [...others.map((each) => each.path), '/code/r-more'],
    })
  })

  test('a named list gives exactly those repositories', () => {
    const all = [member('/code/api'), member('/code/web'), member('/code/docs'), member('/code/infra')]

    expect(plan('/code/api', all, ['/code/docs', '/code/api'])).toMatchObject({
      anchor: '/code',
      workingMemberIsRepository: true,
      repositories: [{ path: '/code/docs', name: 'docs' }],
      otherRepositories: ['/code/web', '/code/infra'],
    })
  })

  test('a repository with no commit and a submodule never get a worktree of their own', () => {
    // WHY: Git cannot check out a repository with no commit, and a submodule comes with the worktree of its parent.
    const all = [
      member('/code/shop', { state: 'plain' }),
      member('/code/shop/api'),
      member('/code/shop/fresh', { hasCommit: false }),
      member('/code/shop/api/libs/shared', { submodule: true }),
    ]

    expect(plan('/code/shop', all)?.repositories).toEqual([{ path: '/code/shop/api', name: 'api' }])
    expect(plan('/code/shop', all, ['/code/shop/api', '/code/shop/fresh', '/code/shop/api/libs/shared'])?.repositories).toEqual([{ path: '/code/shop/api', name: 'api' }])
  })

  test('a named path that cannot be in the task folder is refused with its reason', () => {
    const all = [member('/code/api'), member('/code/notes', { state: 'plain' })]
    expect(() => plan('/code/api', all, ['/code/elsewhere'])).toThrow('/code/elsewhere is not a folder of this session\'s codebase.')
    expect(() => plan('/code/api', all, ['/code/notes'])).toThrow('/code/notes is not a Git repository')

    // WHY: a task folder keeps relative places, and two Windows drives have no folder that holds both.
    const drives = [member('C:\\code\\api'), member('D:\\libs\\ui')]
    expect(() => plan('C:\\code\\api', drives, ['D:\\libs\\ui'])).toThrow('share no folder')
    // Without a choice, the repository on the other drive is left out.
    expect(plan('C:\\code\\api', drives)).toBeNull()
  })

  test('one repository alone needs no task folder', () => {
    expect(plan('/code/api', [member('/code/api')])).toBeNull()
    expect(plan('/code/api', [member('/code/api'), member('/code/web')], [])).toBeNull()
  })

  test('a plain working member always needs a task folder', () => {
    // WHY: a plain folder has no repository to hold a worktree, so only a task folder isolates the session.
    expect(plan('/code/notes', [member('/code/notes', { state: 'plain' })])).toMatchObject({ anchor: '/code/notes', workingMemberIsRepository: false, repositories: [] })
  })

  test('the anchor is the deepest folder that holds the working member and each chosen repository', () => {
    const all = [member('/home/me/shop', { state: 'plain' }), member('/home/me/shop/api'), member('/home/me/libs/ui')]

    expect(plan('/home/me/shop', all)?.anchor).toBe('/home/me')
    expect(plan('/home/me/shop', all, ['/home/me/shop/api'])?.anchor).toBe('/home/me/shop')
  })
})

describe('the layout of a new task folder', () => {
  test('a plain working member gets links for its files and a worktree of each repository at the same place', async () => {
    const { shop, api, web } = shopAt('layout')

    const taskFolder = await createFor(shop, [shop], { branch: 'fix-login' })

    expect(taskFolder.root.startsWith(join(dataDir, TASK_FOLDER_ROOT_NAME, 'fix-login-'))).toBe(true)
    expect(isTaskFolderPath(taskFolder.root)).toBe(true)
    expect(taskFolder).toMatchObject({
      anchor: shop,
      primaryPath: taskFolder.root,
      primaryRepositoryPath: shop,
      primaryIsWorktree: false,
      branch: 'fix-login',
      repositories: [
        { repositoryPath: api, worktreePath: join(taskFolder.root, 'api'), name: 'api' },
        { repositoryPath: web, worktreePath: join(taskFolder.root, 'web'), name: 'web' },
      ],
    })
    // A link is the original; a worktree is a checkout of its own.
    expect(realpathSync(join(taskFolder.root, 'README.md'))).toBe(join(shop, 'README.md'))
    for (const name of ['api', 'web']) {
      expect(isLink(join(taskFolder.root, name))).toBe(false)
      expect(isLinkedWorktree(join(taskFolder.root, name))).toBe(true)
      expect(branchOf(join(taskFolder.root, name))).toBe('fix-login')
    }
    // WHY: the reason for a task folder. A relative path between two repositories also works between their worktrees.
    expect(resolve(join(taskFolder.root, 'api'), '../web')).toBe(join(taskFolder.root, 'web'))
    expect(taskFolders.findTaskFolderContaining(join(taskFolder.root, 'api', 'src'))).toMatchObject({ root: taskFolder.root, codebaseId: 'codebase-test' })
  }, LONG)

  test('a repository outside the working member puts the anchor above both', async () => {
    const { shop, api } = shopAt('outside')
    const ui = repository('outside', 'libs', 'ui')

    const taskFolder = await createFor(shop, [shop, ui], { branch: 'wide', repositories: [api, ui] })

    expect(taskFolder.anchor).toBe(join(sandbox, 'outside'))
    expect(taskFolder.primaryPath).toBe(join(taskFolder.root, 'shop'))
    expect(isLinkedWorktree(join(taskFolder.root, 'shop', 'api'))).toBe(true)
    expect(isLinkedWorktree(join(taskFolder.root, 'libs', 'ui'))).toBe(true)
    expect(isLink(join(taskFolder.root, 'shop', 'README.md'))).toBe(true)
    // WHY: a link is the original, so a member repository that got no worktree must not be reachable through one.
    expect(existsSync(join(taskFolder.root, 'shop', 'web'))).toBe(false)
  }, LONG)

  test('a repository nested in a different one is checked out after it', async () => {
    const mono = repository('nested', 'mono')
    const vendor = repository('nested', 'mono', 'vendor-lib')
    // The plan reads no disk: the nested repository is a member that the caller names.
    const plan = taskFolders.planTaskFolder({ codebaseId: null, workingMember: mono, members: [member(mono), member(vendor, { rootPath: mono, discovered: true })], repositories: null })
    const events: string[] = []
    let recordsAtFirstEvent = -1

    const { taskFolder } = await asHost(() => taskFolders.createTaskFolder(plan!, {
      baseFolder: dataDir,
      branch: 'nested-work',
      baseBranch: null,
      onRepository: (repositoryPath, stage, update) => {
        if (events.length === 0) recordsAtFirstEvent = taskFolders.listTaskFolders().filter((record) => record.branch === 'nested-work').length
        events.push(`${repositoryPath === mono ? 'mono' : 'vendor'}:${stage}:${update.status}`)
      },
    }))

    // WHY: a host that stops in the middle of a creation must find the worktrees that it made, so the record comes first.
    expect(recordsAtFirstEvent).toBe(1)

    // The working member is the anchor, so its worktree is the task folder itself.
    expect(taskFolder).toMatchObject({ primaryPath: taskFolder.root, primaryIsWorktree: true, repositories: [{ repositoryPath: vendor, worktreePath: join(taskFolder.root, 'vendor-lib') }] })
    expect(isLinkedWorktree(taskFolder.root)).toBe(true)
    expect(isLinkedWorktree(join(taskFolder.root, 'vendor-lib'))).toBe(true)
    // WHY: Git refuses a worktree at a folder that is not empty, so the holder must be there first.
    expect(events.indexOf('mono:checkout:done')).toBeGreaterThan(-1)
    expect(events.indexOf('mono:checkout:done')).toBeLessThan(events.findIndex((event) => event.startsWith('vendor:')))
  }, LONG)

  test('the files of `.worktreeinclude` are copied into the worktree of each repository', async () => {
    const { shop, api, web } = shopAt('include')
    for (const repositoryPath of [api, web]) {
      writeFileSync(join(repositoryPath, '.gitignore'), '.env\n')
      writeFileSync(join(repositoryPath, '.worktreeinclude'), '.env\n')
      git(repositoryPath, 'add', '.')
      git(repositoryPath, 'commit', '-q', '-m', 'ignore env')
      writeFileSync(join(repositoryPath, '.env'), `SECRET=${repositoryPath}\n`)
    }

    const taskFolder = await createFor(shop, [shop], { branch: 'with-env' })

    expect(readFileSync(join(taskFolder.root, 'api', '.env'), 'utf-8')).toBe(`SECRET=${api}\n`)
    expect(readFileSync(join(taskFolder.root, 'web', '.env'), 'utf-8')).toBe(`SECRET=${web}\n`)
  }, LONG)
})

describe('the branch of a task folder', () => {
  test('a name that one repository already has gets the same suffix in all of them', async () => {
    // WHY: one piece of work has one branch name, so a pull request of each repository is found by it.
    const { shop, api, web } = shopAt('collision')
    git(web, 'branch', 'fix-cart')

    const taskFolder = await createFor(shop, [shop], { branch: 'fix-cart' })

    expect(taskFolder.branch).toBe('fix-cart-2')
    expect(branchOf(join(taskFolder.root, 'api'))).toBe('fix-cart-2')
    expect(branchOf(join(taskFolder.root, 'web'))).toBe('fix-cart-2')
    expect(branchesOf(api)).not.toContain('fix-cart')
  }, LONG)

  test('a repository that has the base branch starts from it, and each other one from its default branch', async () => {
    const { shop, api, web } = shopAt('base')
    git(api, 'switch', '-q', '-c', 'develop')
    const develop = commit(api, 'feature.txt', 'on develop')
    git(api, 'switch', '-q', 'main')

    const taskFolder = await createFor(shop, [shop], { branch: 'from-develop', baseBranch: 'develop' })

    expect(headOf(join(taskFolder.root, 'api'))).toBe(develop)
    expect(headOf(join(taskFolder.root, 'web'))).toBe(headOf(web))
  }, LONG)
})

describe('a creation that fails', () => {
  test('removes the worktrees, the folder, the record, and the new branches, and keeps what was there before', async () => {
    const mono = repository('failure', 'mono')
    const vendor = repository('failure', 'mono', 'vendor-lib')
    git(mono, 'branch', 'feature')
    // Git cannot register a worktree of this repository. It is nested, so its checkout is the second one.
    writeFileSync(join(vendor, '.git', 'worktrees'), 'not a folder\n')
    // The plan reads no disk: the nested repository is a member that the caller names.
    const plan = taskFolders.planTaskFolder({ codebaseId: null, workingMember: mono, members: [member(mono), member(vendor, { rootPath: mono, discovered: true })], repositories: null })
    const events: string[] = []

    await expect(asHost(() => taskFolders.createTaskFolder(plan!, {
      baseFolder: dataDir,
      branch: 'doomed',
      baseBranch: null,
      onRepository: (repositoryPath, stage, update) => events.push(`${repositoryPath === mono ? 'mono' : 'vendor'}:${stage}:${update.status}`),
    }))).rejects.toThrow()

    // The first checkout ended before the second one failed.
    expect(events).toContain('mono:checkout:done')
    expect(worktreeCountOf(mono)).toBe(1)
    expect(readdirSync(join(dataDir, TASK_FOLDER_ROOT_NAME)).filter((name) => name.startsWith('doomed-'))).toEqual([])
    expect(taskFolders.listTaskFolders().filter((record) => record.branch === 'doomed')).toEqual([])
    // WHY: a failed creation must leave each repository as it was: no new branch, and no branch of the person removed.
    expect(branchesOf(mono).sort()).toEqual(['feature', 'main'])
    expect(branchesOf(vendor)).toEqual(['main'])
  }, LONG)
})

describe('the progress of a creation that fails', () => {
  test('the repository whose worktree fails reports its error, and no other repository reports one', async () => {
    const { shop, api, web } = shopAt('progress-failure')
    // Git cannot register a worktree of this repository.
    writeFileSync(join(web, '.git', 'worktrees'), 'not a folder\n')
    // The plan is made here: this rule is about the reports of the creation, not about the members.
    const plan: TaskFolderPlan = {
      codebaseId: null, anchor: shop, workingMember: shop, workingMemberIsRepository: false,
      repositories: [{ path: api, name: 'api' }, { path: web, name: 'web' }], otherRepositories: [],
    }
    const errors: { repository: string; stage: string; detail: string | undefined }[] = []

    const failure = await asHost(() => taskFolders.createTaskFolder(plan, {
      baseFolder: dataDir,
      branch: 'progress-failure',
      baseBranch: null,
      onRepository: (repositoryPath, stage, update) => {
        if (update.status === 'error') errors.push({ repository: repositoryPath, stage, detail: update.detail })
      },
    })).then(() => null, (error: Error) => error)

    // WHY: the setup card names the error on the row of the repository that failed. The checkout of `api` was only stopped.
    expect(failure).toBeInstanceOf(Error)
    expect(errors).toEqual([{ repository: web, stage: 'checkout', detail: failure!.message }])
  }, LONG)
})

describe('a repository added to a running session', () => {
  test('a new repository gets a worktree on the branch of the task folder', async () => {
    const { shop, api, web } = shopAt('add-new')
    const taskFolder = await createFor(shop, [shop], { branch: 'add-work', repositories: [api] })
    expect(existsSync(join(taskFolder.root, 'web'))).toBe(false)

    const changed = await asHost(() => taskFolders.addRepository(taskFolder.root, web, { baseBranch: null }))

    expect(changed.repositories.map((each) => each.repositoryPath)).toEqual([api, web])
    expect(branchOf(join(taskFolder.root, 'web'))).toBe('add-work')
    expect(taskFolders.findTaskFolderContaining(taskFolder.root)?.repositories).toHaveLength(2)
  }, LONG)

  test('a branch that the repository already has is checked out, not started again', async () => {
    const { shop, api, web } = shopAt('add-existing')
    git(web, 'switch', '-q', '-c', 'shared-work')
    const earlier = commit(web, 'earlier.txt', 'earlier work')
    git(web, 'switch', '-q', 'main')
    const taskFolder = await createFor(shop, [shop], { branch: 'shared-work', repositories: [api] })
    expect(taskFolder.branch).toBe('shared-work')

    await asHost(() => taskFolders.addRepository(taskFolder.root, web, { baseBranch: null }))

    // WHY: the branch can hold commits of an earlier session; a new start from `main` would hide them.
    expect(headOf(join(taskFolder.root, 'web'))).toBe(earlier)
  }, LONG)

  test('a repository that cannot be in the task folder is refused with its reason', async () => {
    const { shop, api } = shopAt('add-refused')
    const library = repository('add-refused', 'library-source')
    git(api, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'libs/shared')
    git(api, 'commit', '-q', '-m', 'add submodule')
    const notes = folder('add-refused', 'shop', 'notes')
    const taskFolder = await createFor(shop, [shop], { branch: 'refusals', repositories: [api] })
    const add = (repositoryPath: string) => asHost(() => taskFolders.addRepository(taskFolder.root, repositoryPath, { baseBranch: null }))

    await expect(add(library)).rejects.toThrow('is outside')
    await expect(add(join(api, 'libs', 'shared'))).rejects.toThrow('is a submodule')
    await expect(add(notes)).rejects.toThrow('is not a Git repository')
    await expect(add(api)).rejects.toThrow('already has its worktree')
    expect(taskFolders.findTaskFolderContaining(taskFolder.root)?.repositories).toHaveLength(1)
  }, LONG)

  test('a link on the way to the new worktree becomes a real folder, and comes back when the worktree is not made', async () => {
    const { shop, api } = shopAt('add-links')
    const tools = folder('add-links', 'shop', 'tools')
    writeFileSync(join(tools, 'notes.txt'), 'notes\n')
    const taskFolder = await createFor(shop, [shop], { branch: 'link-work', repositories: [api] })
    const toolsInTask = join(taskFolder.root, 'tools')
    expect(isLink(toolsInTask)).toBe(true)
    // Made after the session started, so the task folder still reaches it through the link of `tools`.
    const cli = repository('add-links', 'shop', 'tools', 'cli')
    const add = () => asHost(() => taskFolders.addRepository(taskFolder.root, cli, { baseBranch: null }))

    // Git cannot register a worktree of the repository yet.
    writeFileSync(join(cli, '.git', 'worktrees'), 'not a folder\n')
    await expect(add()).rejects.toThrow()
    expect(isLink(toolsInTask)).toBe(true)
    expect(realpathSync(toolsInTask)).toBe(tools)

    unlinkSync(join(cli, '.git', 'worktrees'))
    await add()
    // WHY: a worktree made through the link would be written into the original repository.
    expect(isLink(toolsInTask)).toBe(false)
    expect(realpathSync(join(toolsInTask, 'notes.txt'))).toBe(join(tools, 'notes.txt'))
    expect(isLinkedWorktree(join(toolsInTask, 'cli'))).toBe(true)
    expect(branchOf(join(toolsInTask, 'cli'))).toBe('link-work')
    expect(isLinkedWorktree(cli)).toBe(false)
  }, LONG)
})

describe('the rename of the branch', () => {
  test('each worktree gets the new name', async () => {
    const { shop, api, web } = shopAt('rename')
    git(web, 'branch', 'login-fix')
    const taskFolder = await createFor(shop, [shop], { branch: 'solus/temporary-1' })

    const renamed = await asHost(() => taskFolders.renameBranch(taskFolder.root, 'solus/temporary-1', 'login-fix'))

    // `web` already has `login-fix`, so the one free name has a suffix.
    expect(renamed).toBe('login-fix-2')
    expect(branchOf(join(taskFolder.root, 'api'))).toBe('login-fix-2')
    expect(branchOf(join(taskFolder.root, 'web'))).toBe('login-fix-2')
    expect(branchesOf(api)).not.toContain('solus/temporary-1')
    expect(taskFolders.findTaskFolderContaining(taskFolder.root)?.branch).toBe('login-fix-2')
  }, LONG)

  test('a rename that fails in one repository keeps the old name in all of them', async () => {
    // WHY: two names for one piece of work would hide the pull request of one repository.
    const { shop, web } = shopAt('rename-fails')
    const taskFolder = await createFor(shop, [shop], { branch: 'solus/temporary-2' })
    // Git cannot write the new ref of `web`, the second repository.
    writeFileSync(join(web, '.git', 'refs', 'heads', 'cart-fix.lock'), '')

    await expect(asHost(() => taskFolders.renameBranch(taskFolder.root, 'solus/temporary-2', 'cart-fix'))).rejects.toThrow()

    expect(branchOf(join(taskFolder.root, 'api'))).toBe('solus/temporary-2')
    expect(branchOf(join(taskFolder.root, 'web'))).toBe('solus/temporary-2')
    expect(taskFolders.findTaskFolderContaining(taskFolder.root)?.branch).toBe('solus/temporary-2')
  }, LONG)

  test('a worktree that a person moved to a different branch stops the rename', async () => {
    const { shop } = shopAt('rename-moved')
    const taskFolder = await createFor(shop, [shop], { branch: 'solus/temporary-3' })
    git(join(taskFolder.root, 'web'), 'switch', '-q', '-c', 'my-own-branch')

    expect(await asHost(() => taskFolders.renameBranch(taskFolder.root, 'solus/temporary-3', 'new-name'))).toBeNull()
    expect(branchOf(join(taskFolder.root, 'api'))).toBe('solus/temporary-3')
  }, LONG)
})

describe('the restore of a task folder', () => {
  test('a worktree and a link that are gone come back', async () => {
    const { shop, web } = shopAt('restore')
    const taskFolder = await createFor(shop, [shop], { branch: 'restore-work' })
    const webInTask = join(taskFolder.root, 'web')
    const work = commit(webInTask, 'work.txt', 'work of the session')
    rmSync(webInTask, { recursive: true, force: true })
    unlinkSync(join(taskFolder.root, 'README.md'))

    await asHost(() => taskFolders.restoreTaskFolder(taskFolder))

    // WHY: the branch still has the commits of the session, so the next turn continues from them.
    expect(branchOf(webInTask)).toBe('restore-work')
    expect(headOf(webInTask)).toBe(work)
    expect(realpathSync(join(taskFolder.root, 'README.md'))).toBe(join(shop, 'README.md'))
    expect(worktreeCountOf(web)).toBe(2)
  }, LONG)

  test('a checkout at the place of a worktree that is not a worktree of its repository is an error, and stays', async () => {
    const { shop, web } = shopAt('restore-foreign')
    const taskFolder = await createFor(shop, [shop], { branch: 'foreign-work' })
    const webInTask = join(taskFolder.root, 'web')
    rmSync(webInTask, { recursive: true, force: true })
    git(sandbox, 'clone', '-q', web, webInTask)
    writeFileSync(join(webInTask, 'mine.txt'), 'the work of a person\n')

    await expect(asHost(() => taskFolders.restoreTaskFolder(taskFolder))).rejects.toThrow(`${webInTask} is not a worktree of ${web}`)

    expect(readFileSync(join(webInTask, 'mine.txt'), 'utf-8')).toBe('the work of a person\n')
    expect(isLinkedWorktree(webInTask)).toBe(false)
  }, LONG)
})

describe('the removal of a task folder', () => {
  test('without force, a worktree that has changes stays with its reason and the record holds only what stayed', async () => {
    const { shop, api, web } = shopAt('remove-kept')
    const taskFolder = await createFor(shop, [shop], { branch: 'remove-work' })
    const apiInTask = join(taskFolder.root, 'api')
    writeFileSync(join(apiInTask, 'draft.txt'), 'not committed\n')
    const scratch = join(taskFolder.root, 'scratch.txt')
    writeFileSync(scratch, 'made by the agent\n')

    const removal = await asHost(() => taskFolders.removeTaskFolder(taskFolder.root, { force: false }))

    expect(removal.removed).toEqual([join(taskFolder.root, 'web')])
    expect(removal.kept).toEqual([
      { path: apiInTask, reason: 'has uncommitted changes' },
      { path: scratch, reason: 'exists only in the task folder' },
    ])
    expect(readFileSync(join(apiInTask, 'draft.txt'), 'utf-8')).toBe('not committed\n')
    expect(worktreeCountOf(web)).toBe(1)
    // WHY: a link is the original. Only the link goes; the file of the person stays.
    expect(existsSync(join(taskFolder.root, 'README.md'))).toBe(false)
    expect(readFileSync(join(shop, 'README.md'), 'utf-8')).toBe('the shop\n')
    expect(taskFolders.findTaskFolderContaining(taskFolder.root)?.repositories).toEqual([{ repositoryPath: api, worktreePath: apiInTask, name: 'api' }])
  }, LONG)

  test('with force, the whole task folder goes and the originals stay', async () => {
    const { shop, api, web } = shopAt('remove-forced')
    const taskFolder = await createFor(shop, [shop], { branch: 'forced-work' })
    writeFileSync(join(taskFolder.root, 'api', 'draft.txt'), 'not committed\n')
    writeFileSync(join(taskFolder.root, 'scratch.txt'), 'made by the agent\n')

    const removal = await asHost(() => taskFolders.removeTaskFolder(taskFolder.root, { force: true, deleteBranch: true }))

    expect(removal.kept).toEqual([])
    expect(removal.removed.sort()).toEqual([taskFolder.root, join(taskFolder.root, 'api'), join(taskFolder.root, 'web')].sort())
    expect(existsSync(taskFolder.root)).toBe(false)
    expect(taskFolders.findTaskFolderContaining(taskFolder.root)).toBeNull()
    for (const repositoryPath of [api, web]) {
      expect(worktreeCountOf(repositoryPath)).toBe(1)
      expect(branchesOf(repositoryPath)).toEqual(['main'])
      expect(existsSync(join(repositoryPath, 'README.md'))).toBe(true)
    }
    expect(readFileSync(join(shop, 'README.md'), 'utf-8')).toBe('the shop\n')
  }, LONG)
})

describe('the layout commands of a working member', () => {
  const withLayout = (shop: string, create: string, remove?: string) => {
    mkdirSync(join(shop, '.solus'))
    writeFileSync(join(shop, '.solus', 'config.json'), JSON.stringify({ version: 1, worktreeLayout: { create, remove } }))
  }
  const MAKE_WORKTREES = [
    'printf \'%s\\n\' "$SOLUS_WORKTREE_REPOSITORIES" | while IFS= read -r repository; do',
    '  git -C "$repository" worktree add -q -b "$SOLUS_WORKTREE_BRANCH" "$SOLUS_WORKTREE_ROOT/$(basename "$repository")" || exit 1',
    'done',
  ].join('\n')

  test('the worktrees that the create command makes are adopted', async () => {
    const { shop, api, web } = shopAt('command')
    withLayout(shop, `${MAKE_WORKTREES}\nprintf '%s|%s|%s|%s' "$PWD" "$SOLUS_CODEBASE_ROOT" "$SOLUS_WORKTREE_PRIMARY_PATH" "$SOLUS_WORKTREE_BASE" > "$SOLUS_WORKTREE_ROOT/layout.txt"`)

    const taskFolder = await createFor(shop, [shop], { branch: 'by-command' })

    expect(taskFolder.repositories).toEqual([
      { repositoryPath: api, worktreePath: join(taskFolder.root, 'api'), name: 'api' },
      { repositoryPath: web, worktreePath: join(taskFolder.root, 'web'), name: 'web' },
    ])
    expect(branchOf(join(taskFolder.root, 'web'))).toBe('by-command')
    // The command runs in the working member, and it replaces the built-in layout: no link is made.
    expect(readFileSync(join(taskFolder.root, 'layout.txt'), 'utf-8')).toBe(`${shop}|${shop}|${taskFolder.root}|`)
    expect(existsSync(join(taskFolder.root, 'README.md'))).toBe(false)
  }, LONG)

  test('the remove command runs first, and what it leaves is removed as usual', async () => {
    const { shop, api, web } = shopAt('command-remove')
    const marker = join(sandbox, 'command-remove', 'removed.txt')
    // The command of the project removes one worktree and leaves the other one.
    withLayout(shop, MAKE_WORKTREES, `git -C "$SOLUS_CODEBASE_ROOT/api" worktree remove "$SOLUS_WORKTREE_ROOT/api" && printf '%s' "$SOLUS_WORKTREE_BRANCH" > "${marker}"`)
    const taskFolder = await createFor(shop, [shop], { branch: 'command-teardown' })

    const removal = await asHost(() => taskFolders.removeTaskFolder(taskFolder.root, { force: false }))

    expect(readFileSync(marker, 'utf-8')).toBe('command-teardown')
    expect(removal).toEqual({ removed: [join(taskFolder.root, 'web'), taskFolder.root], kept: [] })
    expect(existsSync(taskFolder.root)).toBe(false)
    expect(worktreeCountOf(api)).toBe(1)
    expect(worktreeCountOf(web)).toBe(1)
    expect(taskFolders.findTaskFolderContaining(taskFolder.root)).toBeNull()
  }, LONG)

  test('a clone that the create command leaves is refused, and the creation is rolled back', async () => {
    // WHY: the session records its work on the branch of each repository. A clone has its own history, so its work would be lost.
    const { shop, api } = shopAt('command-clone')
    withLayout(shop, 'git clone -q "$SOLUS_CODEBASE_ROOT/api" "$SOLUS_WORKTREE_ROOT/api"')

    await expect(createFor(shop, [shop], { branch: 'cloned' })).rejects.toThrow(`is not a worktree of ${api} on the branch cloned`)

    expect(readdirSync(join(dataDir, TASK_FOLDER_ROOT_NAME)).filter((name) => name.startsWith('cloned-'))).toEqual([])
    expect(taskFolders.listTaskFolders().filter((record) => record.branch === 'cloned')).toEqual([])
    expect(branchesOf(api)).toEqual(['main'])
  }, LONG)
})

describe('the record of a task folder', () => {
  test('a task folder is found by a path inside it, in the spelling Solus made and in the real one', () => {
    const real = folder('record', 'real')
    const named = join(sandbox, 'record', 'named')
    symlinkSync(real, named)
    const root = join(named, TASK_FOLDER_ROOT_NAME, 'record-work-0a1b2c3d')
    mkdirSync(root, { recursive: true })
    const record = {
      root, anchor: '/code', primaryPath: join(root, 'api'), primaryRepositoryPath: '/code/api', primaryIsWorktree: true, branch: 'record-work',
      repositories: [{ repositoryPath: '/code/web', worktreePath: join(root, 'web'), name: 'web' }], codebaseId: null, sessionId: null, createdAt: 1,
    }
    store.putTaskFolder(record)

    expect(store.findTaskFolderContaining(join(root, 'api', 'src', 'index.ts'))).toEqual(record)
    expect(store.findTaskFolderContaining(root)).toEqual(record)
    // WHY: a process reports its working directory with the links resolved.
    expect(store.findTaskFolderContaining(join(real, TASK_FOLDER_ROOT_NAME, 'record-work-0a1b2c3d', 'web'))).toEqual(record)
    expect(store.findTaskFolderContaining(join(named, TASK_FOLDER_ROOT_NAME))).toBeNull()
    expect(store.findTaskFolderContaining(join(named, TASK_FOLDER_ROOT_NAME, 'other-work-11111111'))).toBeNull()
    expect(store.findTaskFolderContaining('/code/api')).toBeNull()

    store.removeTaskFolderRecord(root)
    expect(store.findTaskFolderContaining(root)).toBeNull()
  })
})
