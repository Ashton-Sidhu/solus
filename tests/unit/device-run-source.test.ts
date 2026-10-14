import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
  const sources = new DeviceRunSources(join(root, 'owned'), run)
  const first = await sources.prepare(root)
  expect(first.path).not.toBe(root)
  expect(first).toMatchObject({ commit: 'a'.repeat(40), hasChangedCommit: true })
  // Same commit again: dependency setup can be skipped.
  expect((await sources.prepare(root)).hasChangedCommit).toBe(false)
  main = 'b'.repeat(40)
  // A new main commit is built without an explicit update.
  expect(await sources.prepare(root)).toMatchObject({ commit: main, hasChangedCommit: true })
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
  const sources = new DeviceRunSources(join(root, 'owned'), run)
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
  expect((await new DeviceRunSources(join(root, 'owned'), run).prepare(root, 'main', 'feature/mobile')).commit).toBe('c'.repeat(40))
})

test('invalid branch names fail before preparing a checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solus-run-invalid-'))
  roots.push(root)
  const run: DeviceCommandRunner = async (_command, args) => {
    expect(args[0]).toBe('check-ref-format')
    return { code: 1, stdout: '', stderr: '' }
  }
  await expect(new DeviceRunSources(join(root, 'owned'), run).prepare(root, 'main', '../bad')).rejects.toThrow('Choose a valid branch name.')
})
