import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')

// The logger resolves its path once per process, so each probe runs in a child
// with a disposable data directory and never touches the live dev log.
function probe(script: string): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'solus-logger-flush-'))
  try {
    const result = Bun.spawnSync(['bun', '-e', script], {
      cwd: root,
      env: { ...process.env, SOLUS_DATA_DIR: dataDir, SOLUS_INSTALL_DIR: dataDir },
    })
    if (!result.success) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim().split('\n').at(-1) ?? ''
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

describe('logger flush timer', () => {
  test('an entry reaches the file without an explicit flush', () => {
    // WHY: the flush timer starts only when an entry waits. The entry must
    // still be written soon after, with no later entry to start a write.
    const out = probe(`
      const { createLogger, logFilePath } = await import('@solus/server/logger')
      const { readFileSync } = await import('node:fs')
      createLogger('test', 'logger-flush-timer.test.ts').info('flush_timer_probe')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      console.log(JSON.stringify({ written: readFileSync(logFilePath(), 'utf8').includes('flush_timer_probe') }))
    `)
    expect(JSON.parse(out)).toEqual({ written: true })
  })

  test('a quiet process holds no flush timer', () => {
    // WHY: a timer that fires every 500 ms with nothing to write wakes an idle
    // host for no work. After the last write, no timer may be left.
    const out = probe(`
      const { createLogger } = await import('@solus/server/logger')
      createLogger('test', 'logger-flush-timer.test.ts').info('flush_timer_probe')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const timers = process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
      console.log(JSON.stringify({ timers: timers.length }))
    `)
    expect(JSON.parse(out)).toEqual({ timers: 0 })
  })
})
