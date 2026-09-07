import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { sourceFingerprint, assertTestBuild, verificationFingerprint } from '../../scripts/qa/build-identity'
import { validationFor } from '../../scripts/qa/report'
import { setup } from '../../scripts/qa/setup'
import { mockEnvironment, startRun, stopRun, readRun, runStatus, restartRun, disposeRunProject } from '../../scripts/qa/runner'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const runs = join(directory, '.solus-local/runs')
    if (existsSync(runs)) for (const runId of readdirSync(runs)) {
      if (existsSync(join(runs, runId, 'run.json'))) {
        const run = readRun(directory, runId)
        if (existsSync(run.projectDir)) disposeRunProject(directory, runId)
      }
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
function repository(script = `const http=require('http');const fs=require('fs'); const server=http.createServer((_,res)=>res.end('{}')); server.listen(Number(process.env.SOLUS_PORT)||0,'127.0.0.1',()=>fs.writeFileSync(process.env.SOLUS_QA_READY_FILE,JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+server.address().port}))); process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`): string {
  const root = mkdtempSync(join(tmpdir(), 'solus-qa-unit-'))
  directories.push(root)
  execFileSync('git', ['init', '-q', root])
  writeFileSync(join(root, '.gitignore'), 'dist/\n.solus-local/\n')
  mkdirSync(join(root, 'packages'), { recursive: true })
  writeFileSync(join(root, 'packages/input.ts'), 'export const value = 1')
  for (const file of ['main/index.js', 'main/standalone.js', 'preload/index.js', 'renderer/index.html', 'client/index.html']) {
    mkdirSync(join(root, 'dist/test', file, '..'), { recursive: true })
    writeFileSync(join(root, 'dist/test', file), file === 'main/standalone.js' ? script : '')
  }
  writeFileSync(join(root, 'dist/test/build-identity.json'), JSON.stringify({ target: 'test', sourceFingerprint: sourceFingerprint(root) }))
  return root
}

describe('QA proof and isolation', () => {
  test('project disposal refuses running hosts and retains the sandbox through restart', async () => {
    const root = repository()
    const run = await startRun(root)
    try {
      expect(run.projectDir.startsWith(root)).toBe(false)
      expect(() => disposeRunProject(root, run.runId)).toThrow('Stop')
      writeFileSync(join(run.projectDir, 'review.txt'), 'retain me')
      const restarted = await restartRun(root, run.runId)
      expect(restarted.projectDir).toBe(run.projectDir)
      expect(readFileSync(join(run.projectDir, 'review.txt'), 'utf8')).toBe('retain me')
    } finally { await stopRun(root, run.runId) }
    const owner = readFileSync(join(run.projectDir, '.solus-qa-owner.json'), 'utf8')
    writeFileSync(join(run.projectDir, '.solus-qa-owner.json'), 'wrong owner')
    expect(() => disposeRunProject(root, run.runId)).toThrow('ownership')
    writeFileSync(join(run.projectDir, '.solus-qa-owner.json'), owner)
    disposeRunProject(root, run.runId)
    expect(existsSync(run.projectDir)).toBe(false)
  })
  test('uncommitted input changes invalidate the build', () => {
    const root = repository()
    expect(() => assertTestBuild(root)).not.toThrow()
    writeFileSync(join(root, 'packages/input.ts'), 'export const value = 2')
    expect(() => assertTestBuild(root)).toThrow('stale')
  })
  test('harness changes keep the app build usable while build script changes invalidate it', () => {
    const root = repository()
    const before = verificationFingerprint(root)
    mkdirSync(join(root, 'scripts/agent'), { recursive: true })
    writeFileSync(join(root, 'scripts/agent/open-app.ts'), 'new selector')
    expect(() => assertTestBuild(root)).not.toThrow()
    expect(verificationFingerprint(root)).not.toBe(before)
    writeFileSync(join(root, 'scripts/build-parallel.sh'), 'new compiler flags')
    expect(() => assertTestBuild(root)).toThrow('stale')
  })
  test('a production flavor cannot pass mock validation', () => {
    const root = repository()
    writeFileSync(join(root, 'dist/test/build-identity.json'), JSON.stringify({ target: 'production', sourceFingerprint: sourceFingerprint(root) }))
    expect(() => assertTestBuild(root)).toThrow('wrong flavor')
  })
  test('mock child environment excludes inherited credentials and live data', () => {
    const root = repository()
    const environment = mockEnvironment(root, join(root, 'data'), join(root, 'logs'))
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.SOLUS_DATA_DIR).toBe(join(root, 'data'))
    expect(environment.HOME).toBe(join(root, 'data/home'))
  })
  test('symlink paths are refused before creating anything in the target', async () => {
    const root = repository()
    const target = mkdtempSync(join(tmpdir(), 'solus-qa-protected-'))
    directories.push(target)
    symlinkSync(target, join(root, '.solus-local'))
    await expect(startRun(root)).rejects.toThrow('symlinks')
    expect(readdirSync(target)).toEqual([])
  })
  test('setup refuses a shared state directory before installing or writing', () => {
    const root = repository()
    const target = mkdtempSync(join(tmpdir(), 'solus-qa-setup-protected-'))
    directories.push(target)
    symlinkSync(target, join(root, '.solus-local'))
    expect(() => setup(root)).toThrow('must not be a symlink')
    expect(readdirSync(target)).toEqual([])
  })
  test('a host that never becomes ready is stopped and retains failure evidence', async () => {
    const root = repository('setInterval(() => {}, 1000)')
    await expect(startRun(root, { startupTimeoutMs: 50 })).rejects.toThrow('startup exceeded')
    const runId = readdirSync(join(root, '.solus-local/runs'))[0]!
    const run = readRun(root, runId)
    expect(run.status).toBe('failed')
    expect(() => process.kill(run.pid, 0)).toThrow()
  })
  test('owned host reports stale source and stops while retaining evidence', async () => {
    const root = repository()
    const run = await startRun(root)
    try {
      expect((await runStatus(root, run.runId)).status).toBe('running')
      expect(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: run.projectDir, encoding: 'utf8' }).trim()).toBe(run.projectDir)
      writeFileSync(join(root, 'packages/input.ts'), 'changed')
      expect((await runStatus(root, run.runId)).error).toContain('Source changed')
    } finally { await stopRun(root, run.runId) }
    expect(readRun(root, run.runId).status).toBe('stopped')
  })
  test('restart keeps owned data while changing process and log identity', async () => {
    const root = repository()
    const first = await startRun(root)
    writeFileSync(join(first.dataDir, 'review-state.txt'), 'keep this fixture')
    writeFileSync(join(first.directory, 'validation.json'), JSON.stringify({ generationId: first.generationId, sourceFingerprint: first.sourceFingerprint, status: 'passed' }))
    expect(validationFor(first)).toHaveProperty('status', 'passed')
    const next = await restartRun(root, first.runId)
    try {
      expect(next.runId).toBe(first.runId)
      expect(next.pid).not.toBe(first.pid)
      expect(next.url).toBe(first.url)
      expect(next.originChanged).toBe(false)
      expect(next.generationId).not.toBe(first.generationId)
      expect(validationFor(next)).toHaveProperty('behavioral', 'not run')
      writeFileSync(join(next.directory, 'validation.json'), JSON.stringify({ generationId: first.generationId, sourceFingerprint: first.sourceFingerprint, status: 'passed' }))
      expect(validationFor(next)).toHaveProperty('behavioral', 'stale')
      expect(next.logDir).not.toBe(first.logDir)
      expect(readFileSync(join(next.dataDir, 'review-state.txt'), 'utf8')).toBe('keep this fixture')
      expect(readdirSync(join(next.directory, 'history'))).toHaveLength(1)
    } finally { await stopRun(root, next.runId) }
  })
  test('passed checks become stale after the verification harness changes', async () => {
    const root = repository()
    const run = await startRun(root)
    try {
      writeFileSync(join(run.directory, 'validation.json'), JSON.stringify({ generationId: run.generationId, sourceFingerprint: run.sourceFingerprint, status: 'passed' }))
      expect(validationFor(run)).toHaveProperty('status', 'passed')
      mkdirSync(join(root, 'scripts/agent'), { recursive: true })
      writeFileSync(join(root, 'scripts/agent/open-app.ts'), 'changed test interaction')
      expect(validationFor(run)).toHaveProperty('behavioral', 'stale')
      expect(() => assertTestBuild(root)).not.toThrow()
    } finally { await stopRun(root, run.runId) }
  })
  test('startup failure records failed evidence and leaves no owned child', async () => {
    const root = repository('process.exit(2)')
    await expect(startRun(root)).rejects.toThrow('exited')
    const runId = readdirSync(join(root, '.solus-local/runs'))[0]!
    const run = readRun(root, runId)
    expect(run.status).toBe('failed')
    expect(() => process.kill(run.pid, 0)).toThrow()
  })
  test('PID identity mismatch refuses to signal the captured process', async () => {
    const root = repository()
    const run = await startRun(root)
    const path = join(run.directory, 'run.json')
    const original = readFileSync(path, 'utf8')
    writeFileSync(path, JSON.stringify({ ...run, processIdentity: 'different process' }))
    try { await expect(stopRun(root, run.runId)).rejects.toThrow('PID identity changed') }
    finally { writeFileSync(path, original); await stopRun(root, run.runId) }
  })
})
