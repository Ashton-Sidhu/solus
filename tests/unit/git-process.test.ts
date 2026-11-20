import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { git, runAsync, runStreamed } from '@solus/server/git/exec'
import { GitProcessError } from '@solus/server/git/git-process'
import { GitRepository } from '@solus/server/sync/git-storage/git-repository'

// The runner starts processes; with no caller, a project command acts as the host (plans/019).
actAsHostForTests()

let root = ''
let checkout = ''
let storage: GitRepository

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'solus-git-process-'))
  checkout = join(root, 'checkout')
  git(['init', '-b', 'main', checkout], root)
  storage = new GitRepository(join(root, 'storage.git'))
  await storage.init()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** The failure of a command that must fail. */
async function failureOf(command: Promise<string>): Promise<GitProcessError> {
  const error = await command.then(() => null, (reason: Error) => reason)
  if (!(error instanceof GitProcessError)) throw new Error(`Expected a GitProcessError, got ${String(error)}`)
  return error
}

/** Input that never ends, so `hash-object --stdin` runs until something stops it. */
const endlessInput = () => new PassThrough()

// WHY: a caller decides what to do from the reason (retry a time limit, tell a
// person about a stop), and a sync card shows the words of a storage failure.
// A process that Solus stops has no exit code of its own: the error must not
// give it the code 1 of a Git answer, and the storage words must give the
// same number in each caller, not `null` (docs/adr/0005).
test('a process that Solus stops gives a typed reason, no exit code, and the number 1 in the storage words', async () => {
  const timed = await failureOf(new GitRepository(storage.path, { timeoutMs: 100 }).git(['hash-object', '--stdin'], { input: endlessInput() }))
  expect(timed).toMatchObject({ reason: 'timeout', code: null, message: 'The Git hash-object operation failed (1).' })

  const controller = new AbortController()
  const stopped = failureOf(new GitRepository(storage.path, { signal: controller.signal }).git(['hash-object', '--stdin'], { input: endlessInput() }))
  setTimeout(() => controller.abort(), 100)
  expect(await stopped).toMatchObject({ reason: 'stopped', code: null, message: 'The Git hash-object operation failed (1).' })

  const large = await failureOf(new GitRepository(storage.path, { outputLimitBytes: 8 }).git(['hash-object', '--stdin'], { input: 'content' }))
  expect(large).toMatchObject({ reason: 'output-limit', code: null, message: 'The Git hash-object operation failed (1).' })

  expect(await failureOf(runAsync('git', ['rev-parse', 'HEAD'], checkout, { signal: AbortSignal.abort() }))).toMatchObject({ reason: 'stopped', code: null })
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'first'], checkout)
  expect(await failureOf(runAsync('git', ['rev-parse', 'HEAD'], checkout, { maxBuffer: 8 }))).toMatchObject({ reason: 'output-limit', code: null })
})

// WHY: the clients read the words of a failed project command (`Command
// failed:` and Git's own diagnostics), and callers read `stderr`. The command
// line also proves the arguments of the project policy and their order: the
// bare repository guard, then `diff.relative=false`, then the caller's.
test('a failed project command keeps the command line, the exit code, and the diagnostics', async () => {
  const commandLine = 'Command failed: git -c safe.bareRepository=explicit -c diff.relative=false rev-parse --verify no-such-ref\n'
  const waited = await failureOf(runAsync('git', ['rev-parse', '--verify', 'no-such-ref'], checkout))
  expect(waited).toMatchObject({ reason: 'failed', code: 128, signal: null })
  expect(waited.message.startsWith(commandLine)).toBe(true)
  expect(waited.stderr).toContain('fatal: Needed a single revision')
  expect(waited.message).toContain(waited.stderr)

  let immediate: unknown
  try { git(['rev-parse', '--verify', 'no-such-ref'], checkout) } catch (error) { immediate = error }
  expect(immediate).toBeInstanceOf(GitProcessError)
  expect(immediate).toMatchObject({ reason: 'failed', code: 128, stderr: waited.stderr, message: waited.message })

  const streamed = await failureOf(runStreamed(['rev-parse', '--verify', 'no-such-ref'], checkout, { onStderrLine: () => {} }))
  expect(streamed).toMatchObject({ reason: 'failed', code: 128, message: waited.message })
})

// WHY: the diagnostics of storage Git can contain the credential of a remote,
// and a person can see the error. It must keep no output and name no command.
test('a failed storage command keeps no output and names no command', async () => {
  const failure = await failureOf(storage.git(['cat-file', 'blob', '0'.repeat(40)]))
  expect(failure).toMatchObject({ reason: 'failed', code: 128, stdout: '', stderr: '', message: 'The Git cat-file operation failed (128).' })
})

// WHY: ADR 0002 gives the bare repository guard to every Git process Solus
// starts. Storage Git names its repository with `--git-dir`, which the guard
// permits, so it works with the guard and no policy can omit it.
test('a storage command has the bare repository guard and still reads its bare repository', async () => {
  expect((await storage.git(['config', '--get', 'safe.bareRepository'])).trim()).toBe('explicit')
  expect((await storage.git(['rev-parse', '--is-bare-repository'])).trim()).toBe('true')
})

// WHY: a session blob can be a large transcript or a code bundle. It goes to
// Git and comes back as a stream, so the server never holds it in memory.
test('a storage command reads a stream and writes its output to a stream', async () => {
  const input = new PassThrough()
  const blob = storage.writeBlob({ content: 'one two' })
  input.end('one two')
  expect((await storage.git(['hash-object', '-w', '--stdin'], { input })).trim()).toBe(await blob)
  const commit = await storage.writeCommit({ parent: null, message: 'first', keepParentFiles: false, entries: [{ path: 'file', content: 'one two' }] })
  const outFile = join(root, 'out')
  await storage.appendFiles(commit, ['file', 'file'], outFile)
  expect(readFileSync(outFile, 'utf8')).toBe('one twoone two')
})
