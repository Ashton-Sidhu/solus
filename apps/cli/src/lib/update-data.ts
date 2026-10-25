import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isInsideHostPath } from '@solus/contracts/host-path'
import { renameRetrying } from './rename-retry'

/** The child must be stopped. Copy the complete host data, including SQLite
 * WAL files and auxiliary stores. Never follow links into project directories. */
export function snapshotUpdateData(runtimeDir: string, dataDir: string): void {
  const runtime = resolve(runtimeDir)
  const data = resolve(dataDir)
  if (isInsideHostPath(data, runtime) || isInsideHostPath(runtime, data)) {
    throw new Error('The runtime and data directories must be separate.')
  }
  const backup = join(runtime, 'update-data')
  if (existsSync(backup)) { assertSnapshotPath(runtime, data); return }
  writeFileSync(join(runtime, 'update-data-path'), data, { mode: 0o600 })
  syncFile(join(runtime, 'update-data-path'))
  const stage = `${backup}.next`
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(data, { recursive: true })
  cpSync(data, stage, { recursive: true, dereference: false, verbatimSymlinks: true })
  syncTree(stage)
  renameRetrying(stage, backup)
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
  renameRetrying(restored, dataDir)
  syncDirectory(dirname(dataDir))
}

export function discardUpdateData(runtimeDir: string): void {
  rmSync(join(runtimeDir, 'update-data'), { recursive: true, force: true })
  rmSync(join(runtimeDir, 'update-data-path'), { force: true })
}

/** Windows refuses to open a directory for fsync (EPERM). NTFS journals its
 *  metadata, so a rename there is durable without it. */
export function syncDirectory(directory: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return
  const fd = openSync(directory, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** fsync on Windows is FlushFileBuffers, which needs a handle open for writing.
 *  A read-only file there cannot be opened for writing; it is not flushed. */
export function syncFile(file: string, platform: NodeJS.Platform = process.platform): void {
  let fd: number
  try { fd = openSync(file, platform === 'win32' ? 'r+' : 'r') } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) return
    throw error
  }
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function syncTree(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return
  if (!stat.isDirectory()) { syncFile(path); return }
  for (const name of readdirSync(path)) syncTree(join(path, name))
  syncDirectory(path)
}

function assertSnapshotPath(runtimeDir: string, dataDir: string): void {
  if (readFileSync(join(runtimeDir, 'update-data-path'), 'utf8') !== resolve(dataDir)) {
    throw new Error('This update belongs to another data directory. Start Solus with the original --data-dir.')
  }
}
