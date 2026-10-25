import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SetupCloneProjectResult } from '@solus/contracts/types'
import { sameHostPath } from '@solus/contracts/host-path'
import { runDeviceCommand } from '@solus/server/devices/device-process'
import { DeviceRunSources } from '@solus/server/devices/device-run-source'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import { installTestIdentities } from './helpers/acting-identities'

// WHY: the bare-repository guard (docs/adr/0002) must reach every Git process
// Solus starts in production, not only `git/exec.ts`. These tests drive the
// setup handlers and the device runners themselves. The `redirect.git` fixture
// is a Git directory whose own config names another work tree and an origin:
// found implicitly, it would make that folder look like a checkout. Synthetic
// data only; probes read config, and nothing writes the developer's config.

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { registerSetupHandlers } = await import('@solus/server/transport/handlers/setup-handlers')
const { SolusServer } = await import('@solus/server/transport/server')
const { defaultSpawn } = await import('@solus/server/devices/device-run')

installTestIdentities()

const ISOLATED: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}
const REFUSED = /cannot use bare repository/

let base = ''
let checkout = ''
let redirect = ''

function fixtureGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, env: ISOLATED, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

beforeAll(() => {
  // native: on Windows it also expands an 8.3 temp folder name, as git prints the long one.
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'solus-bare-guard-callers-')))
  checkout = join(base, 'checkout')
  mkdirSync(checkout)
  fixtureGit(['init', '-q', '-b', 'main'], checkout)
  writeFileSync(join(checkout, 'file.txt'), 'content\n')
  fixtureGit(['add', 'file.txt'], checkout)
  fixtureGit(['commit', '-q', '-m', 'Initial'], checkout)
  redirect = join(base, 'redirect.git')
  fixtureGit(['clone', '-q', '--bare', checkout, redirect], base)
  fixtureGit(['--git-dir', redirect, 'config', 'core.bare', 'false'], base)
  fixtureGit(['--git-dir', redirect, 'config', 'core.worktree', checkout], base)
  fixtureGit(['--git-dir', redirect, 'config', 'remote.origin.url', 'https://github.com/owner/repo.git'], base)
  // Without the guard, Git finds the folder and follows its config.
  // Git for Windows prints C:/x where Node has C:\x.
  expect(sameHostPath(fixtureGit(['rev-parse', '--show-toplevel'], redirect), checkout)).toBe(true)
})

afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }) })

describe('device runners', () => {
  test('the device command runner refuses the found folder and keeps a checkout', async () => {
    const refused = await runDeviceCommand('git', ['rev-parse', '--show-toplevel'], { cwd: redirect, env: ISOLATED })
    expect(refused.code).toBe(128)
    expect(refused.stderr).toMatch(REFUSED)
    const kept = await runDeviceCommand('git', ['rev-parse', '--show-toplevel'], { cwd: checkout, env: ISOLATED })
    expect(kept.code).toBe(0)
    expect(sameHostPath(kept.stdout.trim(), checkout)).toBe(true)
  })

  test('an owned run checkout is prepared through the guarded runner, upload-pack included', async () => {
    // An untracked file makes a snapshot commit the clone does not have, so
    // the fetch runs the project's upload-pack under the inherited guard.
    writeFileSync(join(checkout, 'untracked.txt'), 'working tree\n')
    try {
      const sources = new DeviceRunSources(join(base, 'owned'), runDeviceCommand, ISOLATED)
      const prepared = await sources.prepare(checkout)
      expect(readFileSync(join(prepared.path, 'untracked.txt'), 'utf8')).toBe('working tree\n')
      await expect(new DeviceRunSources(join(base, 'owned-refused'), runDeviceCommand, ISOLATED).prepare(redirect)).rejects.toThrow(REFUSED)
    } finally {
      rmSync(join(checkout, 'untracked.txt'))
    }
  })

  test('the build spawner refuses the found folder', async () => {
    const child = defaultSpawn('git', ['rev-parse', '--show-toplevel'], { cwd: redirect, env: ISOLATED })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    expect(code).toBe(128)
    expect(stderr).toMatch(REFUSED)
  })
})

describe('setup handlers', () => {
  class FakeChild extends EventEmitter {
    readonly stdout = new PassThrough()
    readonly stderr = new PassThrough()
  }

  function setupServer(spawned: Array<{ file: string; args: string[] }> = []) {
    const server = new SolusServer()
    registerSetupHandlers(server, {
      resolveAgentBinary: async () => null,
      hasCommand: () => false,
      projectsRoot: () => base,
      loadGithubToken: async () => null,
      registerProject: async (path) => `project:${path}`,
      spawnProcess: (file, args) => {
        spawned.push({ file, args })
        const child = new FakeChild()
        setImmediate(() => child.emit('close', 0, null))
        // SAFETY: the setup runner uses only the members FakeChild provides.
        return child as unknown as ChildProcess
      },
    })
    return server
  }

  test('adopting a project refuses a found Git folder and adopts a checkout', async () => {
    const server = setupServer()
    await expect(server.handle('setupAdoptProject', [{ path: redirect }], TEST_HANDLER_CTX)).rejects.toThrow(`There’s no git checkout at ${redirect}.`)
    expect(await server.handle('setupAdoptProject', [{ path: checkout }], TEST_HANDLER_CTX))
      .toEqual({ path: checkout, projectKey: `project:${checkout}` })
  })

  test('a clone starts Git with the guard before its own arguments', async () => {
    const spawned: Array<{ file: string; args: string[] }> = []
    const server = setupServer(spawned)
    const result = await server.handle('setupCloneProject', [{
      cloneUrl: 'https://github.com/owner/repo.git', protocol: 'https', destination: join(base, 'clone-target'),
    }], TEST_HANDLER_CTX) as SetupCloneProjectResult
    expect(result.path).toBe(join(base, 'clone-target'))
    expect(spawned).toHaveLength(1)
    // WHY: the program matters, not its spelling: Windows resolves the full `git.exe` path.
    expect(basename(spawned[0]!.file, '.exe')).toBe('git')
    expect(spawned[0]!.args.slice(0, 2)).toEqual(['-c', 'safe.bareRepository=explicit'])
    expect(spawned[0]!.args.slice(2)).toContain('clone')
  })
})
