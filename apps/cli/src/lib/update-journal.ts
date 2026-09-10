import { discardUpdateData, restoreUpdateData, syncDirectory } from './update-data'
import { isProcessAlive, readLockFile } from './runtime'
import { z } from 'zod'
import { accessSync, closeSync, fsyncSync, openSync, constants, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serverUpdateOperationSchema, type ServerUpdateOperation } from '@solus/contracts/server-update'
import { isManagedVersion } from '@solus/contracts/host-install'
import { readReleaseManifest } from './server-release'
import { activateVersion, currentVersionDir, currentVersionName, pruneStaleDownloads, removeVersion, versionsDir } from './version-store'

const receiptSchema = serverUpdateOperationSchema.extend({ previousVersion: z.string().optional() })

function receiptPath(runtimeDir: string): string {
  return join(runtimeDir, 'update.json')
}

function lockPath(runtimeDir: string): string {
  return join(runtimeDir, 'supervisor.pid')
}

export function writeUpdateReceipt(runtimeDir: string, operation: ServerUpdateOperation | null, previousVersion?: string): void {
  const path = receiptPath(runtimeDir)
  writeFileSync(`${path}.tmp`, JSON.stringify(operation ? { ...operation, previousVersion } : null), { mode: 0o600 })
  const fd = openSync(`${path}.tmp`, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(`${path}.tmp`, path)
  syncDirectory(runtimeDir)
}

function checkInstallationAccess(runtimeDir: string): void {
  const current = currentVersionDir(runtimeDir)
  if (!current) throw new Error('No active Solus installation was found. Run the installer first.')
  if (!isManagedVersion(current)) throw new Error('Remote updates require a packaged server installation.')
  readReleaseManifest(current)
  accessSync(versionsDir(runtimeDir), constants.W_OK)
  accessSync(runtimeDir, constants.W_OK)
}

function acquireSupervisorLock(path: string): void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid supervisor lock. Check this host manually.')
    try { process.kill(pid, 0) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') rmSync(path)
      else throw error
    }
  }
  try { writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 }) }
  catch { throw new Error('Another server owns this installation. Stop duplicate servers before starting it again.') }
}

/** Swaps `current` back to the previous version if the interrupted operation
 *  had already activated its candidate, then discards the candidate's bits. */
function recoverInterruptedUpdate(runtimeDir: string, operation: ServerUpdateOperation, previousVersion: string | undefined): void {
  const activeVersion = currentVersionName(runtimeDir)
  if (activeVersion === operation.version) {
    if (!previousVersion) throw new Error('No previous version was recorded to restore.')
    activateVersion(runtimeDir, previousVersion)
  }
  removeVersion(runtimeDir, operation.version)
  pruneStaleDownloads(runtimeDir)
  readReleaseManifest(currentVersionDir(runtimeDir)!)
}

/** Take an exclusive install lease and recover an interrupted version swap. */
export function prepareSupervisorState(runtimeDir: string, dataDir?: string) {
  let operation: ServerUpdateOperation | null = null
  let previousVersion: string | undefined
  let supported = true
  let reason: string | null = null
  try {
    checkInstallationAccess(runtimeDir)
  } catch (error) {
    supported = false
    reason = 'Remote updates require a writable server installation with update support. Update this host manually first.'
    void error
  }

  const lock = lockPath(runtimeDir)
  let ownsLock = false
  if (supported) {
    acquireSupervisorLock(lock)
    ownsLock = true
  }

  if (ownsLock && existsSync(receiptPath(runtimeDir))) {
    try {
      const receipt = receiptSchema.parse(JSON.parse(readFileSync(receiptPath(runtimeDir), 'utf8')))
      operation = serverUpdateOperationSchema.parse(receipt)
      previousVersion = receipt.previousVersion
    } catch {
      rmSync(lock, { force: true })
      throw new Error('The update record is invalid. Check this host manually.')
    }
  }

  if (ownsLock && operation && (operation.phase === 'restarting' || operation.phase === 'downloading' || operation.phase === 'waiting')) {
    try {
      if (dataDir) restoreStoppedData(runtimeDir, dataDir)
      recoverInterruptedUpdate(runtimeDir, operation, previousVersion)
      operation = { ...operation, phase: 'failed', message: 'The update was interrupted. The previous installation was retained.' }
      writeUpdateReceipt(runtimeDir, operation, previousVersion)
    } catch (error) {
      rmSync(lock, { force: true })
      throw new Error(`Update recovery failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (ownsLock && operation?.phase !== 'restarting' && operation?.phase !== 'downloading') discardUpdateData(runtimeDir)
  return {
    operation,
    supported,
    reason,
    lockPath: lock,
    ownsLock,
    receiptPath: receiptPath(runtimeDir),
    launchInstallDir: currentVersionDir(runtimeDir) ?? undefined,
    previousVersion,
  }
}

function restoreStoppedData(runtimeDir: string, dataDir: string): void {
  const child = readLockFile(join(dataDir, 'server.lock'))
  if (child && isProcessAlive(child.pid)) throw new Error('The previous server is still stopping. Retry after it exits.')
  restoreUpdateData(runtimeDir, dataDir)
}
