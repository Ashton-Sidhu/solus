import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, realpathSync, rmSync, renameSync, mkdtempSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { assertTestBuild, sourceFingerprint, gitRevision, verificationFingerprint } from './build-identity'

export interface RunManifest {
  runId: string
  generationId: string
  previousUrl?: string
  originChanged: boolean
  directory: string
  worktree: string
  dataDir: string
  projectDir: string
  logDir: string
  sourceFingerprint: string
  verificationFingerprint: string
  gitHead: string
  gitBranch: string
  target: 'test'
  pid: number
  processIdentity: string
  url: string
  host: string
  status: 'starting' | 'running' | 'stopped' | 'failed'
  createdAt: string
  error?: string
}
interface Ready { pid: number; url: string }

/** Allowlist rather than inheriting tokens, provider configuration or telemetry. */
export function mockEnvironment(root: string, dataDir: string, logDir: string): NodeJS.ProcessEnv {
  const home = join(dataDir, 'home')
  mkdirSync(home, { recursive: true })
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    LANG: 'en_US.UTF-8',
    NODE_ENV: 'test',
    GIT_CEILING_DIRECTORIES: dataDir,
    SOLUS_TEST_MODE: '1',
    SOLUS_DATA_DIR: dataDir,
    SOLUS_LOG_DIR: logDir,
    SOLUS_HOST: '127.0.0.1',
    SOLUS_PORT: '0',
    SOLUS_NO_UPDATE_CHECK: '1',
    SOLUS_QA_WORKTREE: root,
  }
}

function identity(pid: number): string {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }).trim() }
  catch { return '' }
}
function assertOwnedPath(root: string, directory: string): void {
  let ancestor = directory
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  if (realpathSync(ancestor) !== resolve(ancestor) || !resolve(directory).startsWith(`${realpathSync(root)}/.solus-local/`)) {
    throw new Error('QA run paths must remain inside this worktree without symlinks')
  }
}
function save(run: RunManifest): void {
  writeFileSync(join(run.directory, 'run.json'), JSON.stringify(run, null, 2), { mode: 0o600 })
}
export function readRun(root: string, runId: string): RunManifest {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid QA run ID')
  const directory = join(realpathSync(root), '.solus-local/runs', runId)
  assertOwnedPath(root, directory)
  const run: RunManifest = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'))
  if (run.directory !== directory || run.worktree !== realpathSync(root)) throw new Error('QA run belongs to another worktree')
  return run
}
function assertProjectOwnership(run: Pick<RunManifest, 'projectDir' | 'directory' | 'runId' | 'worktree'>): void {
  const project = run.projectDir
  const temporaryRoot = realpathSync(tmpdir())
  if (dirname(project) !== temporaryRoot || !project.startsWith(join(temporaryRoot, `solus-qa-project-${run.runId}-`)) || realpathSync(project) !== project) {
    throw new Error('QA project ownership does not match this run')
  }
  const expected = JSON.stringify({ runId: run.runId, worktree: run.worktree, projectDir: project })
  if (readFileSync(join(project, '.solus-qa-owner.json'), 'utf8') !== expected || readFileSync(join(run.directory, 'project-owner.json'), 'utf8') !== expected) {
    throw new Error('QA project ownership does not match this run')
  }
}
/** Stop retains review state. Disposal removes only a stopped run's owned project. */
export function disposeRunProject(root: string, runId: string): void {
  const run = readRun(root, runId)
  if (run.status === 'running' || run.status === 'starting' || (run.pid > 0 && identity(run.pid) === run.processIdentity)) throw new Error('Stop the QA host before disposing its project')
  assertProjectOwnership(run)
  rmSync(run.projectDir, { recursive: true })
}
export async function runStatus(root: string, runId: string): Promise<RunManifest> {
  const run = readRun(root, runId)
  if (run.status !== 'running') return run
  if (identity(run.pid) !== run.processIdentity) return { ...run, status: 'stopped' }
  if (run.sourceFingerprint !== sourceFingerprint(root)) return { ...run, error: 'Source changed since this host started. Rebuild, then restart this run.' }
  try {
    const health = await fetch(`${run.url}/health`, { signal: AbortSignal.timeout(2000) })
    if (!health.ok) return { ...run, error: `Health returned ${health.status}` }
  } catch { return { ...run, error: 'Host health request failed' } }
  return run
}

export interface StartOptions { host?: '127.0.0.1' | '0.0.0.0'; startupTimeoutMs?: number; provider?: 'claude-code' | 'codex'; resumeRunId?: string }
interface PreparedRun { runId: string; directory: string; dataDir: string; projectDir: string; logDir: string; previousUrl?: string }
function prepareRun(root: string, options: StartOptions): PreparedRun {
  const previous = options.resumeRunId ? readRun(root, options.resumeRunId) : undefined
  if (previous && identity(previous.pid) === previous.processIdentity) throw new Error('Stop the existing QA host before reusing its data')
  const runId = previous?.runId ?? randomUUID()
  const directory = join(root, '.solus-local/runs', runId)
  assertOwnedPath(root, directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // Refuse a symlink that could redirect test writes into live state.
  if (realpathSync(directory) !== resolve(directory)) throw new Error('QA run directories must not be symlinks')
  const dataDir = join(directory, 'data')
  assertOwnedPath(root, dataDir)
  mkdirSync(dataDir, { recursive: true })
  const projectDir = previous?.projectDir ?? mkdtempSync(join(realpathSync(tmpdir()), `solus-qa-project-${runId}-`))
  if (previous) assertProjectOwnership(previous)
  else {
    const owner = JSON.stringify({ runId, worktree: root, projectDir })
    writeFileSync(join(projectDir, '.solus-qa-owner.json'), owner, { mode: 0o600 })
    writeFileSync(join(directory, 'project-owner.json'), owner, { mode: 0o600 })
  }
  if (!existsSync(join(projectDir, '.git'))) execFileSync('git', ['init', '-q', projectDir], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  if (!previous) writeFileSync(join(dataDir, 'server-settings.json'), JSON.stringify({ projectsBaseDirectory: projectDir, hostConfig: { activeAgent: options.provider ?? 'claude-code' } }))
  if (previous) {
    const archive = join(directory, 'history', previous.generationId ?? String(Date.now()))
    assertOwnedPath(root, archive)
    mkdirSync(archive, { recursive: true })
    writeFileSync(join(archive, 'run.json'), JSON.stringify(previous, null, 2))
    for (const file of ['validation.json', 'report.json', 'scenario.json']) {
      if (existsSync(join(directory, file))) renameSync(join(directory, file), join(archive, file))
    }
  }
  rmSync(join(directory, 'ready.json'), { force: true })
  const logDir = previous ? join(directory, 'logs', randomUUID()) : join(directory, 'logs')
  assertOwnedPath(root, logDir)
  mkdirSync(logDir, { recursive: true })
  return { runId, directory, dataDir, projectDir, logDir, previousUrl: previous?.url }
}
export async function startRun(root: string, options: StartOptions = {}): Promise<RunManifest> {
  root = realpathSync(root)
  const build = assertTestBuild(root)
  const { runId, directory, dataDir, projectDir, logDir, previousUrl } = prepareRun(root, options)
  const descriptor = openSync(join(logDir, 'console.log'), 'a', 0o600)
  const child = spawn('node', ['--enable-source-maps', join(root, 'dist/test/main/standalone.js')], {
    cwd: root,
    env: { ...mockEnvironment(root, dataDir, logDir), SOLUS_HOST: options.host ?? '127.0.0.1', SOLUS_PORT: previousUrl ? new URL(previousUrl).port : '0', SOLUS_QA_READY_FILE: join(directory, 'ready.json') },
    stdio: ['ignore', descriptor, descriptor],
    detached: true,
  })
  closeSync(descriptor)
  let spawnError: Error | undefined
  child.on('error', (error) => { spawnError = error })
  const run: RunManifest = {
    runId, generationId: randomUUID(), previousUrl, originChanged: false, directory, ...gitRevision(root), worktree: root, dataDir, projectDir, logDir,
    sourceFingerprint: build.sourceFingerprint, verificationFingerprint: verificationFingerprint(root), target: 'test', pid: child.pid ?? 0,
    processIdentity: child.pid ? identity(child.pid) : '', url: '', host: options.host ?? '127.0.0.1', status: 'starting', createdAt: new Date().toISOString(),
  }
  save(run)
  try {
    if (spawnError) throw spawnError
    return await awaitReady(child, run, options.startupTimeoutMs ?? 30_000)
  } catch (error) {
    // This child object was captured at spawn; no process search is involved.
    child.kill('SIGTERM')
    const exitDeadline = Date.now() + 3000
    while (child.exitCode === null && !child.signalCode && child.pid && Date.now() < exitDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
    if (child.exitCode === null && !child.signalCode && child.pid) child.kill('SIGKILL')
    child.unref()
    run.status = 'failed'
    run.error = String(error)
    save(run)
    throw error
  }
}

async function awaitReady(child: ChildProcess, run: RunManifest, timeoutMs: number): Promise<RunManifest> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!child.pid) throw new Error('QA host could not start; check that node is installed')
      if (child.exitCode !== null || child.signalCode) throw new Error('QA host exited during startup; inspect console.log')
      const readyFile = join(run.directory, 'ready.json')
      if (existsSync(readyFile)) {
        const ready: Ready = JSON.parse(readFileSync(readyFile, 'utf8'))
        if (ready.pid !== run.pid || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url)) throw new Error('QA host identity mismatch')
        const response = await fetch(`${ready.url}/health`, { signal: AbortSignal.timeout(2000) })
        if (!response.ok) throw new Error(`QA health returned ${response.status}`)
        run.url = ready.url
        run.originChanged = !!run.previousUrl && run.previousUrl !== ready.url
        run.status = 'running'
        save(run)
        child.unref()
        return run
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    throw new Error('QA host startup exceeded 30 seconds')
}

export async function stopRun(root: string, runId: string): Promise<void> {
  const run = readRun(root, runId)
  if (run.status === 'stopped') return
  const currentIdentity = identity(run.pid)
  if (currentIdentity && currentIdentity !== run.processIdentity) throw new Error('PID identity changed; refusing to stop another process')
  if (currentIdentity) {
    process.kill(run.pid, 'SIGTERM')
    const deadline = Date.now() + 10_000
    while (identity(run.pid) === run.processIdentity && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    if (identity(run.pid) === run.processIdentity) throw new Error('QA host did not stop; evidence retained')
  }
  run.status = 'stopped'
  save(run)
}

export async function restartRun(root: string, runId: string): Promise<RunManifest> {
  assertTestBuild(root)
  const previous = readRun(root, runId)
  await stopRun(root, runId)
  return startRun(root, { host: previous.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1', resumeRunId: runId })
}
