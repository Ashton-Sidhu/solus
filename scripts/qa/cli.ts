import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, realpathSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validationFor } from './report'
import { createQaWorktree } from './worktree'
import { dependenciesReady, setup } from './setup'
import { assertTestBuild, sourceFingerprint, verificationFingerprint } from './build-identity'
import { mockEnvironment, readRun, runStatus, startRun, stopRun, restartRun, disposeRunProject } from './runner'

const root = process.cwd()
const [command = 'help', runId] = process.argv.slice(2)
const args = process.argv.slice(3)
const valid = command === 'help' && args.length === 0
  || ['doctor', 'check', 'smoke'].includes(command) && args.length === 0
  || command === 'setup' && (args.length === 0 || args.length === 1 && runId === '--warm')
  || command === 'start' && (args.length === 0 || args.length === 2 && runId === '--host' && args[1] === '0.0.0.0')
  || ['status', 'dispose-project', 'stop', 'restart', 'report', 'worktree'].includes(command) && args.length === 1
  || command === 'handoff' && args.length === 2
if (!valid) throw new Error('Invalid QA command or arguments. Run bun run qa help.')
function requireRunId(): string {
  if (!runId) throw new Error('Pass the run ID printed by qa start')
  return runId
}
function ensureSetup(): void { if (!dependenciesReady(root)) setup(root) }
function runCheck(): void {
  ensureSetup()
  const checks = ['check:typescript', 'check:svelte', 'check:qa', 'lint', 'lint:rules']
  const results = checks.map((name) => ({ command: `bun run ${name}`, exitCode: spawnSync('bun', ['run', name], { cwd: root, stdio: 'inherit' }).status }))
  writeFileSync(join(root, '.solus-local/checks.json'), JSON.stringify({ sourceFingerprint: sourceFingerprint(root), results }, null, 2))
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1
}

switch (command) {
  case 'doctor': {
    const playwright = await import('@playwright/test').catch(() => null)
    const executable = playwright?.chromium.executablePath()
    const results = {
      worktree: root,
      bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(),
      node: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
      dependenciesReady: dependenciesReady(root),
      sourceFingerprint: sourceFingerprint(root),
      mockBuild: 'ready',
      chromium: { path: executable ?? 'dependencies missing', installed: !!executable && existsSync(executable) },
      workspacePackages: ['contracts', 'server', 'client-core', 'workspace-ui'].map((name) => ({ name, path: existsSync(join(root, 'node_modules/@solus', name)) ? realpathSync(join(root, 'node_modules/@solus', name)) : 'missing' })),
    }
    try { assertTestBuild(root) } catch (error) { results.mockBuild = String(error) }
    console.log(JSON.stringify(results, null, 2))
    if (!results.dependenciesReady || !results.chromium.installed || results.mockBuild !== 'ready') process.exitCode = 1
    break
  }
  case 'setup': {
    setup(root)
    if (runId === '--warm') execFileSync('bun', ['run', 'vite', 'optimize', '--config', 'apps/client/vite.config.ts'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, BUILD_TARGET: 'test' }, stdio: 'inherit' })
    break
  }
  case 'check': runCheck(); break
  case 'start': {
    const host = runId === '--host' ? process.argv[4] : '127.0.0.1'
    if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('Use qa start [--host 0.0.0.0]')
    ensureSetup()
    console.log(JSON.stringify(await startRun(root, { host }), null, 2))
    break
  }
  case 'status': {
    const run = await runStatus(root, requireRunId())
    console.log(JSON.stringify(run, null, 2))
    if (run.status !== 'running' || run.error) process.exitCode = 1
    break
  }
  case 'worktree': {
    const result = createQaWorktree(root, requireRunId())
    console.log(JSON.stringify(result, null, 2))
    if (result.readiness !== 'ready') process.exitCode = 1
    break
  }
  case 'restart': ensureSetup(); console.log(JSON.stringify(await restartRun(root, requireRunId()), null, 2)); break
  case 'dispose-project': disposeRunProject(root, requireRunId()); console.log('Disposed owned QA project. Run evidence is retained.'); break
  case 'stop': await stopRun(root, requireRunId()); console.log('Stopped. Run evidence is retained.'); break
  case 'smoke': {
    ensureSetup()
    assertTestBuild(root)
    const result = spawnSync('bun', ['run', 'playwright', 'test', '--config', 'playwright.smoke.config.ts'], { cwd: root, stdio: 'inherit' })
    process.exitCode = result.status ?? 1
    break
  }
  case 'report': {
    const run = await runStatus(root, requireRunId())
    const log = join(run.logDir, 'solus.log')
    const errors = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('"level":"error"')).length : 0
    const report = { run, currentVerificationFingerprint: verificationFingerprint(root), errors, artifacts: readdirSync(run.directory), validation: validationFor(run) }
    writeFileSync(join(run.directory, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    break
  }
  case 'handoff': {
    const run = readRun(root, requireRunId())
    const label = process.argv[4]
    if (!label) throw new Error('Use qa handoff <run-id> <device-label>; issue a separate credential for each client')
    const status = await runStatus(root, run.runId)
    if (status.status !== 'running' || status.error) throw new Error('Run is not healthy and current')
    // Credential goes only to the requesting terminal, never the run manifest.
    console.log(`Fresh pairing link for ${label}. Open this link only on that client.`)
    execFileSync('bun', [join(root, 'apps/cli/src/index.ts'), 'pair', '--data-dir', run.dataDir], { cwd: root, env: mockEnvironment(root, run.dataDir, join(run.directory, 'auth-logs')), stdio: 'inherit' })
    break
  }
  default: console.log('bun run qa <doctor|setup [--warm]|worktree BRANCH|check|start [--host 0.0.0.0]|status RUN|stop RUN|dispose-project RUN|restart RUN|smoke|report RUN|handoff RUN DEVICE>')
}
