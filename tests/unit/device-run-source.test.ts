import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRunSources } from '@solus/server/devices/device-run-source'
import type { DeviceCommandRunner } from '@solus/server/devices/device-process'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

test('each run checks out the newest main in an owned checkout and reports when it changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solus-run-source-'))
  roots.push(root)
  let main = 'a'.repeat(40)
  const checkouts: { cwd: string; commit: string }[] = []
  const run: DeviceCommandRunner = async (_command, args, options) => {
    if (args[0] === 'clone') await mkdir(join(args.at(-1)!, '.git'), { recursive: true })
    if (args[0] === 'checkout') checkouts.push({ cwd: options!.cwd!, commit: args.at(-1)! })
    return { code: 0, stdout: args[0] === 'rev-parse' ? main : '', stderr: '' }
  }
  const sources = new DeviceRunSources(join(root, 'owned'), run, process.env)
  const first = await sources.prepare(root)
  expect(first.path).not.toBe(root)
  expect(first).toMatchObject({ commit: 'a'.repeat(40), hasChangedSource: true })
  // Same commit again: dependency setup can be skipped.
  expect((await sources.prepare(root)).hasChangedSource).toBe(false)
  main = 'b'.repeat(40)
  // A new main commit is built without an explicit update.
  expect(await sources.prepare(root)).toMatchObject({ commit: main, hasChangedSource: true })
  expect(checkouts.map((checkout) => checkout.commit)).toEqual(['a'.repeat(40), 'a'.repeat(40), main])
  expect(checkouts.every((checkout) => checkout.cwd === first.path)).toBe(true)
})

test('named branches use separate owned checkouts and resolve an exact branch ref', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solus-run-branches-'))
  roots.push(root)
  const refs: string[] = []
  const run: DeviceCommandRunner = async (_command, args) => {
    if (args[0] === 'clone') await mkdir(join(args.at(-1)!, '.git'), { recursive: true })
    if (args[0] === 'rev-parse') refs.push(args.at(-1)!)
    return { code: 0, stdout: args[0] === 'rev-parse' ? 'b'.repeat(40) : '', stderr: '' }
  }
  const sources = new DeviceRunSources(join(root, 'owned'), run, process.env)
  const main = await sources.prepare(root, 'main', 'main')
  const feature = await sources.prepare(root, 'main', 'feature/mobile')
  expect(feature.path).not.toBe(main.path)
  expect(feature.path).not.toBe(root)
  expect(refs).toEqual(['refs/heads/main^{commit}', 'refs/heads/feature/mobile^{commit}'])
})

test('remote-only branches resolve without changing the project checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solus-run-remote-'))
  roots.push(root)
  const run: DeviceCommandRunner = async (_command, args) => {
    if (args[0] === 'clone') await mkdir(join(args.at(-1)!, '.git'), { recursive: true })
    if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: 'no local branch' }
    return { code: 0, stdout: args[0] === 'for-each-ref' ? `${'c'.repeat(40)} refs/remotes/upstream/feature/mobile` : '', stderr: '' }
  }
  expect((await new DeviceRunSources(join(root, 'owned'), run, process.env).prepare(root, 'main', 'feature/mobile')).commit).toBe('c'.repeat(40))
})

test('invalid branch names fail before preparing a checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solus-run-invalid-'))
  roots.push(root)
  const run: DeviceCommandRunner = async (_command, args) => {
    expect(args[0]).toBe('check-ref-format')
    return { code: 1, stdout: '', stderr: '' }
  }
  await expect(new DeviceRunSources(join(root, 'owned'), run, process.env).prepare(root, 'main', '../bad')).rejects.toThrow('Choose a valid branch name.')
})

test('a build contains the working tree of the branch, uncommitted and untracked files included, and leaves it as it was', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solus-run-working-'))
  roots.push(root)
  const project = join(root, 'project')
  const run: DeviceCommandRunner = async (command, args, options) => {
    const result = spawnSync(command, [...args], { cwd: options?.cwd, env: options?.env, encoding: 'utf8' })
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
  }
  const git = (...args: string[]) => run('git', args, { cwd: project, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  await mkdir(project)
  await git('init', '-q', '-b', 'main')
  await writeFile(join(project, '.gitignore'), 'ios/\n')
  await writeFile(join(project, 'app.json'), 'committed')
  await writeFile(join(project, 'removed.txt'), 'committed')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'first')
  await writeFile(join(project, 'app.json'), 'edited')
  await rm(join(project, 'removed.txt'))
  await writeFile(join(project, 'new.txt'), 'untracked')
  await mkdir(join(project, 'ios'))
  await writeFile(join(project, 'ios', 'generated.txt'), 'ignored')
  await git('add', 'new.txt')
  const statusBefore = (await git('status', '--porcelain')).stdout

  const sources = new DeviceRunSources(join(root, 'owned'), run, process.env)
  const first = await sources.prepare(project, 'main', 'main')
  expect(first.commit).toBe((await git('rev-parse', 'HEAD')).stdout.trim())
  expect(await readFile(join(first.path, 'app.json'), 'utf8')).toBe('edited')
  expect(await readFile(join(first.path, 'new.txt'), 'utf8')).toBe('untracked')
  expect(await stat(join(first.path, 'removed.txt')).catch(() => null)).toBeNull()
  expect(await stat(join(first.path, 'ios')).catch(() => null)).toBeNull()
  // The person's files and staging are untouched.
  expect((await git('status', '--porcelain')).stdout).toBe(statusBefore)
  expect(first.hasChangedSource).toBe(true)

  // The same working state is the same source, so setup can be skipped.
  expect((await sources.prepare(project, 'main', 'main')).hasChangedSource).toBe(false)
  await writeFile(join(project, 'app.json'), 'edited again')
  const changed = await sources.prepare(project, 'main', 'main')
  expect(changed.hasChangedSource).toBe(true)
  expect(await readFile(join(changed.path, 'app.json'), 'utf8')).toBe('edited again')

  // A branch checked out in another worktree builds that worktree's state.
  await git('worktree', 'add', '-q', '-b', 'feature', join(root, 'feature'))
  await writeFile(join(root, 'feature', 'feature.txt'), 'in progress')
  const feature = await sources.prepare(project, 'main', 'feature')
  expect(await readFile(join(feature.path, 'feature.txt'), 'utf8')).toBe('in progress')
})
