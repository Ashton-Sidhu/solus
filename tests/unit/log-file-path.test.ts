import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')

// The logger resolves its path once, at module load, and a development runtime
// resolves it to `<cwd>/dev.log` — which it truncates. Probing it in this
// process would wipe the developer's live dev log, so the probe runs in a child
// with a packaged runtime and a disposable data directory of its own.
function probeLogFile(dataDir: string): { path: string; contents: string } {
  const probe = `
    const { createLogger, flushLogs, logFilePath } = await import('@solus/server/logger')
    createLogger('test', 'log-file-path.test.ts').info('log_path_probe', { probe: 'value' })
    flushLogs()
    const { readFileSync } = await import('node:fs')
    const path = logFilePath()
    console.log(JSON.stringify({ path, contents: readFileSync(path, 'utf8') }))
  `
  const result = Bun.spawnSync(['bun', '-e', probe], {
    cwd: root,
    env: { ...process.env, SOLUS_DATA_DIR: dataDir, SOLUS_INSTALL_DIR: dataDir },
  })
  if (!result.success) throw new Error(result.stderr.toString())
  return JSON.parse(result.stdout.toString())
}

// The desktop main cannot configure the platform before `logger.ts` evaluates —
// ES module bodies all run before the first statement of `index.ts`. This probe
// reproduces that order exactly: import the logger, *then* register `appInfo`,
// then log. `SOLUS_INSTALL_DIR` is deliberately unset so the packaged decision
// has to come from `appInfo` alone.
//
// The child runs from `logsPath`, not the repo, and imports the logger by
// absolute path. When this test fails it fails because the logger fell back to
// `<cwd>/dev.log` — so `cwd` must never be the repo, or the failing run would
// truncate the developer's live dev log on its way to reporting the defect.
function probeElectronLogFile(logsPath: string): { path: string; contents: string } {
  const loggerModule = join(root, 'packages/server/src/logger.ts')
  const servicesModule = join(root, 'packages/server/src/platform/services.ts')
  const probe = `
    const { createLogger, flushLogs, logFilePath } = await import(${JSON.stringify(loggerModule)})
    const { configurePlatformServices } = await import(${JSON.stringify(servicesModule)})
    configurePlatformServices({
      appInfo: {
        appPath: ${JSON.stringify(root)},
        isPackaged: true,
        logsPath: ${JSON.stringify(logsPath)},
        userDataPath: ${JSON.stringify(logsPath)},
        version: '0.0.0-test',
      },
    })
    createLogger('test', 'log-file-path.test.ts').info('log_path_probe', { probe: 'value' })
    flushLogs()
    const { readFileSync } = await import('node:fs')
    const path = logFilePath()
    console.log('PROBE:' + JSON.stringify({ path, contents: readFileSync(path, 'utf8') }))
  `
  const env = { ...process.env, SOLUS_DATA_DIR: logsPath }
  delete env.SOLUS_INSTALL_DIR
  const result = Bun.spawnSync(['bun', '-e', probe], { cwd: logsPath, env })
  if (!result.success) throw new Error(result.stderr.toString())
  // A development runtime also pretty-prints every entry to stdout, so the
  // result is tagged rather than assumed to be the only thing on the stream.
  // Without this the regression surfaces as a JSON parse error instead of the
  // assertion that explains which path was chosen.
  const tagged = result.stdout.toString().split('\n').find((line: string) => line.startsWith('PROBE:'))
  if (!tagged) throw new Error(`probe produced no result:\n${result.stdout.toString()}`)
  return JSON.parse(tagged.slice('PROBE:'.length))
}

// A genuine development runtime: no `SOLUS_INSTALL_DIR`, no registered
// `appInfo`. Returns both paths so a test can assert they diverge. Runs from
// `dataDir` because `logFilePath()` truncates `<cwd>/dev.log` here.
function probeDevRuntimePaths(dataDir: string): { writes: string; opens: string } {
  const loggerModule = join(root, 'packages/server/src/logger.ts')
  const probe = `
    const { logFilePath, productionLogFilePath } = await import(${JSON.stringify(loggerModule)})
    console.log('PROBE:' + JSON.stringify({ writes: logFilePath(), opens: productionLogFilePath() }))
  `
  const env = { ...process.env, SOLUS_DATA_DIR: dataDir }
  delete env.SOLUS_INSTALL_DIR
  const result = Bun.spawnSync(['bun', '-e', probe], { cwd: dataDir, env })
  if (!result.success) throw new Error(result.stderr.toString())
  const tagged = result.stdout.toString().split('\n').find((line: string) => line.startsWith('PROBE:'))
  if (!tagged) throw new Error(`probe produced no result:\n${result.stdout.toString()}`)
  return JSON.parse(tagged.slice('PROBE:'.length))
}

describe('host log file path', () => {
  test('opens the production log even on a development host', () => {
    // WHY: "Open Solus logs" is a production diagnostic. It handed the developer
    // `dev.log` — and, once the packaged app started misreading its own runtime,
    // a `/dev.log` that never existed. The command must name the durable
    // `solus.log` on every runtime, while the writer keeps using `dev.log` in
    // development. These two paths are allowed to differ; the command's must not
    // follow the writer's.
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-log-dev-'))
    try {
      const { writes, opens } = probeDevRuntimePaths(dataDir)
      expect(opens).toBe(join(dataDir, 'logs', 'solus.log'))
      expect(opens.endsWith('dev.log')).toBe(false)
      expect(writes.endsWith('dev.log')).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('the RPC the palette calls is wired to the production log', () => {
    // WHY: pinning `productionLogFilePath` alone would still pass if the handler
    // were pointed back at the writer's path — which is exactly the state that
    // shipped `dev.log` to the user. This is a source assertion rather than a
    // call: `observability-handlers` pulls in `node:sqlite`, which Bun does not
    // provide, so the module cannot be imported by this runner at all.
    const source = readFileSync(
      join(root, 'packages/server/src/server/handlers/observability-handlers.ts'),
      'utf8',
    )
    expect(source).toContain("server.register('logFilePath', () => productionLogFilePath())")
  })

  test('treats a packaged Electron runtime as packaged', () => {
    // WHY: the packaged app registers `appInfo` after the logger module has
    // already evaluated. When the logger read that flag at module load it saw an
    // unconfigured runtime, chose `<cwd>/dev.log`, and — cwd being `/` for a
    // Finder launch — silently discarded every production log entry for eight
    // days. The runtime decision must survive being made before boot finishes.
    const logsPath = mkdtempSync(join(tmpdir(), 'solus-log-electron-'))
    try {
      const { path, contents } = probeElectronLogFile(logsPath)
      expect(path).toBe(join(logsPath, 'solus.log'))
      expect(contents).toContain('log_path_probe')
    } finally {
      rmSync(logsPath, { recursive: true, force: true })
    }
  })

  test('names the file the logger actually writes', () => {
    // WHY: on a packaged host the command's path and the writer's path are the
    // same file, so this pins the writer to `<logsDir>/solus.log`. If the writer
    // ever drifts, "Open Solus logs" opens an empty or stale file and quietly
    // lies about what the host recorded.
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-log-path-'))
    try {
      const { path, contents } = probeLogFile(dataDir)
      expect(path).toBe(join(dataDir, 'logs', 'solus.log'))
      expect(contents).toContain('log_path_probe')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
