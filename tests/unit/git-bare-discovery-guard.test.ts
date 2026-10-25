import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sameHostPath } from '@solus/contracts/host-path'
import { git, gitCommitExists, runAsync } from '@solus/server/git/exec'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

// WHY: Solus runs Git in folders that projects and agents write. A bare
// repository found only because a working directory is inside it brings its
// own config (hooks, fsmonitor, aliases). Solus refuses that discovery and
// keeps every repository it reaches on purpose: a checkout, a linked worktree,
// a bare repository's worktree, a submodule, and an explicit --git-dir.
// Every fixture is synthetic and isolated from the developer's Git config.

actAsHostForTests()

const ISOLATED: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const AUTHOR: NodeJS.ProcessEnv = {
  ...ISOLATED,
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}
const run = (args: string[], cwd: string, env: NodeJS.ProcessEnv = AUTHOR) => runAsync('git', args, cwd, { env })
// Git for Windows prints C:/x where Node has C:\x.
const expectSamePath = (actual: string, expected: string) => expect(sameHostPath(actual, expected)).toBe(true)

let base = ''
let bare = ''
let checkout = ''

beforeAll(async () => {
  // native: on Windows it also expands an 8.3 temp folder name, as git prints the long one.
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'solus-bare-guard-')))
  bare = join(base, 'shared.git')
  checkout = join(base, 'checkout')
  mkdirSync(checkout)
  await run(['init', '-q', '-b', 'main'], checkout)
  writeFileSync(join(checkout, 'file.txt'), 'content\n')
  await run(['add', 'file.txt'], checkout)
  await run(['commit', '-q', '-m', 'Initial'], checkout)
  await run(['clone', '-q', '--bare', checkout, bare], base)
  // The marker is what an implicit read would leak.
  await run(['--git-dir', bare, 'config', 'audit.marker', 'bare-config'], base)
})

afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }) })

describe('a bare repository found by walking up', () => {
  test('is refused from inside it and from below it', async () => {
    await expect(run(['rev-parse', '--git-common-dir'], bare)).rejects.toThrow(/cannot use bare repository/)
    await expect(run(['rev-parse', '--git-common-dir'], join(bare, 'refs'))).rejects.toThrow(/cannot use bare repository/)
    expect(() => git(['rev-parse', '--git-common-dir'], bare, { env: ISOLATED })).toThrow(/cannot use bare repository/)
  })

  test('never has its config read, and a commit check answers false', async () => {
    await expect(run(['config', '--get', 'audit.marker'], bare)).rejects.toThrow()
    expect(await gitCommitExists(bare, 'HEAD')).toBe(false)
  })

  test('is refused when embedded in a project and reached with -C', async () => {
    const project = join(base, 'project-with-embedded')
    mkdirSync(project)
    await run(['init', '-q', '--bare', join(project, 'vendor.git')], project)
    await expect(run(['-C', join(project, 'vendor.git'), 'rev-parse', '--git-dir'], project)).rejects.toThrow(/cannot use bare repository/)
  })

  test('stays refused when inherited config tries to allow it', async () => {
    const globalConfig = join(base, 'allow-all.gitconfig')
    writeFileSync(globalConfig, '[safe]\n\tbareRepository = all\n')
    const attempts: NodeJS.ProcessEnv[] = [
      { ...ISOLATED, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.bareRepository', GIT_CONFIG_VALUE_0: 'all' },
      { ...ISOLATED, GIT_CONFIG_PARAMETERS: "'safe.bareRepository'='all'" },
      { ...ISOLATED, GIT_CONFIG_GLOBAL: globalConfig },
    ]
    for (const env of attempts) {
      await expect(run(['rev-parse', '--git-common-dir'], bare, env)).rejects.toThrow(/cannot use bare repository/)
    }
  })
})

describe('repositories Solus reaches on purpose', () => {
  test('an explicit --git-dir or GIT_DIR still reads a bare repository', async () => {
    expect(await run(['--git-dir', bare, 'config', '--get', 'audit.marker'], base)).toBe('bare-config')
    expect(await run(['config', '--get', 'audit.marker'], base, { ...ISOLATED, GIT_DIR: bare })).toBe('bare-config')
  })

  test('a checkout, its .git folder, and the caller options before the subcommand', async () => {
    expect(await run(['status', '--porcelain'], checkout)).toBe('')
    expect(await run(['rev-parse', '--git-dir'], join(checkout, '.git'))).toBe('.')
    expectSamePath(await run(['-C', checkout, '-c', 'core.quotepath=false', 'rev-parse', '--show-toplevel'], base), checkout)
    expectSamePath(git(['rev-parse', '--show-toplevel'], checkout, { env: ISOLATED }), checkout)
    expect(await gitCommitExists(checkout, 'HEAD')).toBe(true)
  })

  test("a bare repository's worktree, and a new worktree added from it", async () => {
    const worktree = join(base, 'bare-worktree')
    await run(['--git-dir', bare, 'worktree', 'add', '-q', '-b', 'feature', worktree, 'main'], base)
    expectSamePath(await run(['rev-parse', '--git-common-dir'], worktree), bare)
    expect(await run(['status', '--porcelain'], worktree)).toBe('')
    const second = join(base, 'bare-worktree-2')
    await run(['worktree', 'add', '-q', '-b', 'second', second, 'main'], worktree)
    expect(await run(['rev-parse', '--abbrev-ref', 'HEAD'], second)).toBe('second')
  })

  test('the .bare layout, where a .git file names the bare repository', async () => {
    const root = join(base, 'layout')
    mkdirSync(root)
    await run(['clone', '-q', '--bare', checkout, join(root, '.bare')], base)
    writeFileSync(join(root, '.git'), 'gitdir: ./.bare\n')
    await run(['worktree', 'add', '-q', join(root, 'main'), 'main'], root)
    expectSamePath(await run(['rev-parse', '--git-common-dir'], join(root, 'main')), join(root, '.bare'))
    expect(await run(['status', '--porcelain'], join(root, 'main'))).toBe('')
  })

  test('a linked worktree of a checkout, and a submodule', async () => {
    const linked = join(base, 'linked')
    await run(['worktree', 'add', '-q', '-b', 'linked', linked], checkout)
    expect(await run(['status', '--porcelain'], linked)).toBe('')

    const superproject = join(base, 'superproject')
    mkdirSync(superproject)
    await run(['init', '-q', '-b', 'main'], superproject)
    await run(['-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', checkout, 'child'], superproject)
    expectSamePath(await run(['rev-parse', '--show-toplevel'], join(superproject, 'child')), join(superproject, 'child'))
    expect(await run(['submodule', 'status'], superproject)).toContain('child')
  })

  test('a hook runs, and inherits the guard', async () => {
    const hooked = join(base, 'hooked')
    await run(['clone', '-q', checkout, hooked], base)
    const seen = join(base, 'hook-saw.txt')
    const hook = join(hooked, '.git', 'hooks', 'pre-commit')
    // `/` separators: Git for Windows runs the hook in its own sh.
    const seenInHook = seen.replaceAll('\\', '/')
    writeFileSync(hook, `#!/bin/sh\ngit config --get safe.bareRepository > "${seenInHook}"\ngit rev-parse --show-toplevel >> "${seenInHook}"\n`)
    chmodSync(hook, 0o755)
    writeFileSync(join(hooked, 'file.txt'), 'changed\n')
    await run(['commit', '-q', '-am', 'Through a hook'], hooked)
    const [guard, topLevel] = readFileSync(seen, 'utf8').split('\n')
    expect(guard).toBe('explicit')
    expectSamePath(topLevel ?? '', hooked)
  })
})
