import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreUpdateData, snapshotUpdateData } from '../../apps/cli/src/lib/update-data'
import { superviseServer } from '../../apps/cli/src/lib/server-supervisor'
import { assertCompatibleRelease } from '../../apps/cli/src/lib/server-release'
import { activateVersion, currentVersionDir, currentVersionName, versionsDir } from '../../apps/cli/src/lib/version-store'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const nodeBinary = Bun.which('node')
if (!nodeBinary) throw new Error('Supervisor tests require Node.js.')
const operationId = '00000000-0000-4000-8000-000000000001'

function install(directory: string, version: string, fail = false) {
  mkdirSync(join(directory, 'bin'), { recursive: true })
  mkdirSync(join(directory, 'libexec/server'), { recursive: true })
  mkdirSync(join(directory, 'libexec/cli'), { recursive: true })
  symlinkSync(nodeBinary, join(directory, 'bin/node'))
  writeFileSync(join(directory, 'libexec/cli/solus.js'), '')
  writeFileSync(join(directory, 'server-release.json'), JSON.stringify({ protocol: 1, version, storage: 'same' }))
  writeFileSync(join(directory, 'libexec/server/standalone.js'), `
    if (${fail}) process.exit(1);
    const version = ${JSON.stringify(version)};
    let requested = false;
    process.on('message', message => {
      if (message.type === 'solus:stop-for-update') process.exit(0);
      if (message.type !== 'solus:update-status') return;
      const operation = message.support.operation;
      if (operation?.phase === 'waiting') process.send({type: 'solus:drained', operationId: operation.operationId});
      if (operation?.phase === 'failed' || operation?.phase === 'succeeded') process.exit(0);
      if (!requested && !operation) {
        requested = true;
        process.send({type: 'solus:update', operation: {operationId: '${operationId}', version: '1.1.0', phase: 'downloading'}});
      }
    });
    process.send({type: 'solus:ready', version});
  `)
}

/** Stages a candidate the same way the real download path does: beside `versions/`. */
function stageVersion(runtimeDir: string, version: string, fail = false): string {
  const stage = mkdtempSync(join(versionsDir(runtimeDir), '.download-'))
  const next = join(stage, 'install')
  mkdirSync(next)
  install(next, version, fail)
  return next
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'solus-supervisor-test-'))
  directories.push(directory)
  const runtimeDir = join(directory, 'runtime')
  mkdirSync(versionsDir(runtimeDir), { recursive: true })
  const v1 = join(versionsDir(runtimeDir), '1.0.0')
  install(v1, '1.0.0')
  activateVersion(runtimeDir, '1.0.0')
  const dataDir = join(directory, 'data')
  return {
    directory,
    runtimeDir,
    dataDir,
    receipt: () => JSON.parse(readFileSync(join(runtimeDir, 'update.json'), 'utf8')),
    activeVersion: () => currentVersionName(runtimeDir),
  }
}

test('the supervisor activates a confirmed version and retains the previous runtime', async () => {
  const f = fixture()
  const code = await superviseServer({
    runtimeDir: f.runtimeDir, dataDir: f.dataDir, env: { ...process.env, SOLUS_DATA_DIR: f.dataDir },
    stage: async () => stageVersion(f.runtimeDir, '1.1.0'),
  })
  expect(code).toBe(0)
  expect(f.receipt().phase).toBe('succeeded')
  expect(f.activeVersion()).toBe('1.1.0')
  expect(existsSync(join(f.runtimeDir, 'supervisor.pid'))).toBe(false)
  expect(existsSync(join(f.runtimeDir, 'versions', '1.0.0'))).toBe(true)
})

test('failed startup restores and launches the previous version', async () => {
  const f = fixture()
  await superviseServer({
    runtimeDir: f.runtimeDir, dataDir: f.dataDir, env: { ...process.env, SOLUS_DATA_DIR: f.dataDir },
    stage: async () => stageVersion(f.runtimeDir, '1.1.0', true),
  })
  expect(f.receipt().phase).toBe('failed')
  expect(f.receipt().message).toContain('previous version was restored')
  expect(f.activeVersion()).toBe('1.0.0')
  expect(existsSync(join(f.runtimeDir, 'versions', '1.1.0'))).toBe(false)
})

test('download failure leaves the running installation intact', async () => {
  const f = fixture()
  await superviseServer({
    runtimeDir: f.runtimeDir, dataDir: f.dataDir, env: { ...process.env, SOLUS_DATA_DIR: f.dataDir },
    stage: async () => { throw new Error('Download failed') },
  })
  expect(f.receipt().phase).toBe('failed')
  expect(f.activeVersion()).toBe('1.0.0')
})

test('storage migrations are permitted but the requested version must match', () => {
  const f = fixture()
  const current = currentVersionDir(f.runtimeDir)!
  const next = join(f.directory, 'next')
  install(next, '1.1.0')
  expect(() => assertCompatibleRelease(current, next, '1.1.0')).not.toThrow()
  expect(() => assertCompatibleRelease(current, next, '1.2.0')).toThrow('requested version')
  writeFileSync(join(next, 'server-release.json'), JSON.stringify({ protocol: 1, version: '1.1.0', storage: 'changed' }))
  expect(() => assertCompatibleRelease(current, next, '1.1.0')).not.toThrow()
})

test('an interrupted swap is recovered before the server starts', async () => {
  const f = fixture()
  const v11 = join(versionsDir(f.runtimeDir), '1.1.0')
  install(v11, '1.1.0')
  activateVersion(f.runtimeDir, '1.1.0') // simulates the swap that happened right before the crash
  writeFileSync(join(f.runtimeDir, 'update.json'), JSON.stringify({ operationId, version: '1.1.0', phase: 'restarting', previousVersion: '1.0.0' }))

  await superviseServer({ runtimeDir: f.runtimeDir, dataDir: f.dataDir, env: { ...process.env, SOLUS_DATA_DIR: f.dataDir } })

  expect(f.receipt().phase).toBe('failed')
  expect(f.activeVersion()).toBe('1.0.0')
  expect(existsSync(v11)).toBe(false)
})

test('a second supervisor cannot update the same installation', async () => {
  const f = fixture()
  writeFileSync(join(f.runtimeDir, 'supervisor.pid'), String(process.pid))
  await expect(superviseServer({ runtimeDir: f.runtimeDir, dataDir: f.dataDir, env: {} })).rejects.toThrow('Another server')
  expect(readFileSync(join(f.runtimeDir, 'supervisor.pid'), 'utf8')).toBe(String(process.pid))
})

test('a server that never confirms startup is stopped before rollback', async () => {
  const f = fixture()
  await superviseServer({
    runtimeDir: f.runtimeDir, dataDir: f.dataDir, env: { ...process.env, SOLUS_DATA_DIR: f.dataDir }, startupTimeoutMs: 50,
    stage: async () => {
      const next = stageVersion(f.runtimeDir, '1.1.0')
      writeFileSync(join(next, 'libexec/server/standalone.js'), "process.on('message', () => {}); setInterval(() => {}, 1000)")
      return next
    },
  })
  expect(f.receipt().phase).toBe('failed')
  expect(f.activeVersion()).toBe('1.0.0')
})

 test('failed candidate restores auxiliary state and SQLite bytes before restarting the old server', async () => {
  const f = fixture()
  mkdirSync(f.dataDir)
  writeFileSync(join(f.dataDir, 'settings.json'), 'original settings')
  writeFileSync(join(f.dataDir, 'state.sqlite'), 'original database')
  await superviseServer({ runtimeDir: f.runtimeDir, dataDir: f.dataDir, env: { ...process.env, SOLUS_DATA_DIR: f.dataDir },
    stage: async () => {
      const next = stageVersion(f.runtimeDir, '1.1.0')
      writeFileSync(join(next, 'libexec/server/standalone.js'), `
        const fs = require('node:fs'); const p = require('node:path');
        fs.writeFileSync(p.join(process.env.SOLUS_DATA_DIR, 'settings.json'), 'migrated');
        fs.writeFileSync(p.join(process.env.SOLUS_DATA_DIR, 'state.sqlite'), 'migrated db');
        fs.writeFileSync(p.join(process.env.SOLUS_DATA_DIR, 'new-file'), 'trial');
        process.exit(1);
      `)
      return next
    },
  })
  expect(readFileSync(join(f.dataDir, 'settings.json'), 'utf8')).toBe('original settings')
  expect(readFileSync(join(f.dataDir, 'state.sqlite'), 'utf8')).toBe('original database')
  expect(existsSync(join(f.dataDir, 'new-file'))).toBe(false)
})

test('interrupted trial restores data before recovery launches the previous version', async () => {
  const f = fixture()
  mkdirSync(f.dataDir)
  writeFileSync(join(f.dataDir, 'settings.json'), 'before')
  snapshotUpdateData(f.runtimeDir, f.dataDir)
  writeFileSync(join(f.dataDir, 'settings.json'), 'after')
  install(join(versionsDir(f.runtimeDir), '1.1.0'), '1.1.0')
  activateVersion(f.runtimeDir, '1.1.0')
  writeFileSync(join(f.runtimeDir, 'update.json'), JSON.stringify({ operationId, version: '1.1.0', phase: 'restarting', previousVersion: '1.0.0' }))
  await superviseServer({ runtimeDir: f.runtimeDir, dataDir: f.dataDir, env: {} })
  expect(readFileSync(join(f.dataDir, 'settings.json'), 'utf8')).toBe('before')
  expect(f.activeVersion()).toBe('1.0.0')
})


test('recovery cannot restore a snapshot into a different host data directory', () => {
  const f = fixture()
  mkdirSync(f.dataDir)
  snapshotUpdateData(f.runtimeDir, f.dataDir)
  const other = join(f.directory, 'other-data')
  mkdirSync(other)
  writeFileSync(join(other, 'keep'), 'other host')
  expect(() => restoreUpdateData(f.runtimeDir, other)).toThrow('another data directory')
  expect(readFileSync(join(other, 'keep'), 'utf8')).toBe('other host')
})
