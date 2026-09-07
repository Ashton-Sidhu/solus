import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('independent QA processes append their own logs without touching dev.log', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-qa-logs-'))
  const logger = join(import.meta.dir, '../../packages/server/src/logger.ts')
  try {
    writeFileSync(join(directory, 'dev.log'), 'developer evidence')
    for (const run of ['first', 'second', 'first']) {
      const logDir = join(directory, run)
      mkdirSync(logDir, { recursive: true })
      const result = Bun.spawnSync(['bun', '-e', `const {createLogger,flushLogs}=await import(${JSON.stringify(logger)}); createLogger('qa','probe').info('qa_owned_log'); flushLogs()`], {
        cwd: directory, env: { PATH: process.env.PATH, SOLUS_LOG_DIR: logDir, SOLUS_DATA_DIR: directory },
      })
      expect(result.exitCode).toBe(0)
    }
    expect(readFileSync(join(directory, 'dev.log'), 'utf8')).toBe('developer evidence')
    expect(readFileSync(join(directory, 'first/solus.log'), 'utf8').trim().split('\n')).toHaveLength(2)
    expect(readFileSync(join(directory, 'second/solus.log'), 'utf8').trim().split('\n')).toHaveLength(1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
