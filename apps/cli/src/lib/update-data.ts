import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** The child must be stopped. Copy the complete host data, including SQLite
 * WAL files and auxiliary stores. Never follow links into project directories. */
export function snapshotUpdateData(runtimeDir: string, dataDir: string): void {
  const runtime = resolve(runtimeDir)
  const data = resolve(dataDir)
  if (runtime === data || runtime.startsWith(`${data}/`) || data.startsWith(`${runtime}/`)) {
    throw new Error('The runtime and data directories must be separate.')
  }
  const backup = join(runtime, 'update-data')
  if (existsSync(backup)) { assertSnapshotPath(runtime, data); return }
  writeFileSync(join(runtime, 'update-data-path'), data, { mode: 0o600 })
  syncDirectory(join(runtime, 'update-data-path'))
  const stage = `${backup}.next`
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(data, { recursive: true })
  cpSync(data, stage, { recursive: true, dereference: false, verbatimSymlinks: true })
  syncTree(stage)
  renameSync(stage, backup)
  syncDirectory(runtime)
}

/** Keep the backup until rollback is durably recorded. Retrying after a crash
 * restores the same snapshot, even if the previous restore stopped halfway. */
export function restoreUpdateData(runtimeDir: string, dataDir: string): void {
  const backup = join(runtimeDir, 'update-data')
  if (!existsSync(backup)) return
  assertSnapshotPath(runtimeDir, dataDir)
  const restored = `${dataDir}.solus-restore`
  rmSync(restored, { recursive: true, force: true })
  cpSync(backup, restored, { recursive: true, dereference: false, verbatimSymlinks: true })
  for (const name of ['server.lock', 'server.pid']) rmSync(join(restored, name), { force: true })
  syncTree(restored)
  rmSync(dataDir, { recursive: true, force: true })
  renameSync(restored, dataDir)
  syncDirectory(dirname(dataDir))
}

export function discardUpdateData(runtimeDir: string): void {
  rmSync(join(runtimeDir, 'update-data'), { recursive: true, force: true })
  rmSync(join(runtimeDir, 'update-data-path'), { force: true })
}

export function syncDirectory(directory: string): void {
  const fd = openSync(directory, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function syncTree(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) for (const name of readdirSync(path)) syncTree(join(path, name))
  syncDirectory(path)
}

function assertSnapshotPath(runtimeDir: string, dataDir: string): void {
  if (readFileSync(join(runtimeDir, 'update-data-path'), 'utf8') !== resolve(dataDir)) {
    throw new Error('This update belongs to another data directory. Start Solus with the original --data-dir.')
  }
}
