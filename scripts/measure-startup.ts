#!/usr/bin/env bun
/**
 * Measure the packaged app's startup time.
 *
 * Launches `release/mac-arm64/Solus.app`'s binary N times with
 * `SOLUS_STARTUP_TRACE=1`, reads the phase marks it writes to stdout, and
 * reports the median split of the critical path. The headline number is
 * `spawn -> window shown`: process spawn to the `solus:renderer-ready` IPC that
 * makes the editor window visible, which is the first moment a user sees Solus.
 *
 * Each run gets an isolated data directory and a free port so a bench never
 * touches — or races — the Solus the developer is actually using. The directory
 * is created once and reused across runs, so run 2..N see the warm caches a
 * relaunch really has.
 *
 * Usage:
 *   bun scripts/measure-startup.ts [--runs 7] [--app <path>] [--label baseline]
 */
import { spawn } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

const PHASES = [
  'main.evaluated',
  'app.ready',
  'window.created',
  'renderer.domReady',
  'renderer.didFinishLoad',
  'solus.boot.start',
  'solus.boot.connection',
  'solus.boot.transport',
  'solus.boot.modules',
  'solus.boot.mounted',
  'renderer.ready',
  'core.booted',
] as const
type Phase = (typeof PHASES)[number]

/** Reported as an absolute mark: these run beside the critical path, not on it. */
const OFF_CRITICAL_PATH: ReadonlySet<string> = new Set(['core.booted'])

/** The mark that ends the measurement: main shows the window on this one. */
const TERMINAL_PHASE: Phase = 'renderer.ready'
/** The renderer's own marks arrive just after it, so the run settles on the next tick. */
const MARK_DRAIN_MS = 400
/** A run that has not shown its window by now is a failure, not a slow start. */
const RUN_TIMEOUT_MS = 60_000
/** Away from 3001 (desktop) and 3000, so a bench never collides with the real app. */
const BENCH_PORT = 43117

interface RunResult {
  /** Milliseconds from spawn to each phase. Absent if the phase never fired. */
  phases: Partial<Record<Phase, number>>
  total: number
}

interface BenchOptions {
  runs: number
  appPath: string
  label: string
  keepData: boolean
}

function parseArgs(): BenchOptions {
  const argv = process.argv.slice(2)
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  return {
    runs: Number(read('--runs') ?? 7),
    appPath: resolve(read('--app') ?? 'release/mac-arm64/Solus.app'),
    label: read('--label') ?? 'run',
    keepData: !argv.includes('--fresh-data'),
  }
}

async function measureOnce(binary: string, dataDir: string): Promise<RunResult> {
  const spawnedAt = Date.now()
  const child = spawn(binary, [`--user-data-dir=${join(dataDir, 'userData')}`], {
    env: {
      ...process.env,
      SOLUS_STARTUP_TRACE: '1',
      SOLUS_DATA_DIR: dataDir,
      SOLUS_PORT: String(BENCH_PORT),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  const phases: Partial<Record<Phase, number>> = {}
  let settle: (value: RunResult) => void
  let fail: (error: Error) => void
  const done = new Promise<RunResult>((res, rej) => {
    settle = res
    fail = rej
  })

  const timer = setTimeout(() => fail(new Error('run timed out before the window was shown')), RUN_TIMEOUT_MS)

  let pending = ''
  child.stdout.on('data', (chunk: Buffer) => {
    pending += chunk.toString()
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('SOLUS_STARTUP ')) continue
      const [, phase, epoch] = line.split(' ')
      // SAFETY: an unrecognised phase name only adds a key the report never
      // reads — it iterates PHASES, not the recorded keys.
      phases[phase as Phase] = Number(epoch) - spawnedAt
      if (phase === TERMINAL_PHASE) {
        const total = Number(epoch) - spawnedAt
        clearTimeout(timer)
        // The renderer's marks are read back over the debug channel and land a
        // few milliseconds behind the IPC that ends the run. Settling on this
        // line would drop them from every report.
        setTimeout(() => settle({ phases, total }), MARK_DRAIN_MS)
      }
    }
  })
  child.on('exit', (code) => {
    clearTimeout(timer)
    fail(new Error(`app exited (code ${code}) before the window was shown`))
  })

  try {
    return await done
  } finally {
    child.kill('SIGTERM')
    // The app intercepts the first quit for a bounded cleanup pass; give it that
    // window before insisting, so the next run starts from a clean database.
    await new Promise<void>((res) => {
      const kill = setTimeout(() => {
        child.kill('SIGKILL')
        res()
      }, 5_000)
      child.on('exit', () => {
        clearTimeout(kill)
        res()
      })
    })
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function ms(value: number): string {
  return `${value.toFixed(0)} ms`
}

async function main(): Promise<void> {
  const { runs, appPath, label, keepData } = parseArgs()
  const binary = join(appPath, 'Contents/MacOS/Solus')
  const dataDir = join(tmpdir(), 'solus-startup-bench')
  if (!keepData) rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(join(dataDir, 'userData'), { recursive: true })

  process.stdout.write(`measuring ${appPath}\n`)
  process.stdout.write(`data dir  ${dataDir}\n\n`)

  const results: RunResult[] = []
  // Run 1 is discarded: it pays for the first read of an 877 MB bundle and, on a
  // fresh data dir, for one-time setup. Neither is what a relaunch costs.
  for (let run = 0; run <= runs; run++) {
    const result = await measureOnce(binary, dataDir)
    const tag = run === 0 ? 'warmup' : `run ${run}`
    process.stdout.write(`${tag.padEnd(7)} ${ms(result.total)}\n`)
    if (run > 0) results.push(result)
  }

  process.stdout.write(`\n=== ${label} (median of ${results.length}) ===\n`)
  let previous = 0
  for (const phase of PHASES) {
    const samples = results.map((r) => r.phases[phase]).filter((v): v is number => v !== undefined)
    if (samples.length === 0) continue
    const at = median(samples)
    // Server boot runs concurrently with the renderer, so a delta against the
    // previous row would be meaningless — report its absolute mark only.
    const offPath = OFF_CRITICAL_PATH.has(phase)
    const delta = offPath ? '' : `  (+${ms(at - previous)})`
    if (!offPath) previous = at
    process.stdout.write(`${phase.padEnd(24)} ${ms(at).padStart(9)}${delta}\n`)
  }
  const totals = results.map((r) => r.total)
  process.stdout.write(
    `\nspawn -> window shown    ${ms(median(totals)).padStart(9)}` +
      `   (min ${ms(Math.min(...totals))}, max ${ms(Math.max(...totals))})\n`,
  )
}

void main()
