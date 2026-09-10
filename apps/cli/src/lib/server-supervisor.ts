import { snapshotUpdateData, restoreUpdateData, discardUpdateData } from './update-data'
import { prepareSupervisorState, writeUpdateReceipt } from './update-journal'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { supervisorMessageSchema, type ServerUpdateSupport, type SupervisorMessage } from '@solus/contracts/server-update'
import { stageServerRelease } from './server-release'
import { runtimePaths } from './runtime'
import { activateVersion, currentVersionDir, finalizeStagedVersion, removeVersion, versionDir } from './version-store'

interface SupervisorOptions {
  runtimeDir: string
  dataDir: string
  env: NodeJS.ProcessEnv
  stage?: typeof stageServerRelease
  startupTimeoutMs?: number
}

/** The original `solus start` process remains the service manager's child. */
export async function superviseServer(options: SupervisorOptions): Promise<number> {
  const initial = prepareSupervisorState(options.runtimeDir, options.dataDir)
  let paths = runtimePaths(options.dataDir, initial.launchInstallDir)
  let previousVersion = initial.previousVersion
  let operation = initial.operation
  const { supported, reason, lockPath, ownsLock } = initial
  const persist = () => writeUpdateReceipt(options.runtimeDir, operation, previousVersion)

  let child: ChildProcess | null = null
  /** Downloaded and verified, but not yet finalized into `versions/`. */
  let staged: string | null = null
  let stopping = false
  let updating = false
  let candidate = false
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null
  let finish!: (code: number) => void
  const finished = new Promise<number>((resolve) => { finish = resolve })
  const support = (): ServerUpdateSupport => ({ supported, reason, operation })
  const send = (message: SupervisorMessage) => {
    if (child?.connected) child.send(message, () => {})
  }
  const publish = () => send({ type: 'solus:update-status', support: support() })
  const fail = (message: string) => {
    if (operation) { operation = { ...operation, phase: 'failed', message }; persist() }
    updating = false
    publish()
  }
  const clearTimers = () => {
    if (startupTimer) clearTimeout(startupTimer)
    if (shutdownTimer) clearTimeout(shutdownTimer)
    startupTimer = null
    shutdownTimer = null
  }
  const cancelStagedUpdate = () => {
        if (staged) rmSync(dirname(staged), { recursive: true, force: true })
        staged = null
        updating = false
        operation = { ...operation!, phase: 'cancelled' }
        persist()
        publish()
  }
  const matchesWaiting = (message: SupervisorMessage): boolean =>
    'operationId' in message && operation?.operationId === message.operationId && operation?.phase === 'waiting'
  const launch = () => {
    const launched = spawn(paths.nodePath, [paths.serverEntry, '--data-dir', paths.dataDir], {
      env: { ...options.env, SOLUS_INSTALL_DIR: paths.installDir, SOLUS_UPDATE_SUPERVISED: '1', SOLUS_UPDATE_SUPPORT: JSON.stringify(support()) },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    })
    child = launched
    if (candidate) {
      startupTimer = setTimeout(() => {
        // Only the child we spawned can be stopped. Wait for exit before rollback.
        launched.kill('SIGKILL')
      }, options.startupTimeoutMs ?? 60_000)
    }
    launched.on('message', (raw) => {
      const parsed = supervisorMessageSchema.safeParse(raw)
      if (!parsed.success || child !== launched || stopping) return
      const message = parsed.data
      const matchesWaitingUpdate = matchesWaiting(message)
      if (message.type === 'solus:ready') {
        if (candidate && operation) {
          if (message.version !== operation.version) { launched.kill('SIGKILL'); return }
          clearTimers()
          candidate = false
          updating = false
          operation = { ...operation, phase: 'succeeded' }
          persist()
          discardUpdateData(options.runtimeDir)
        }
        publish()
      } else if (message.type === 'solus:cancel-update' && matchesWaitingUpdate) {
        cancelStagedUpdate()
      } else if (message.type === 'solus:drained' && staged && matchesWaitingUpdate) {
        operation = { ...operation!, phase: 'restarting' }
        persist()
        publish()
        send({ type: 'solus:stop-for-update', operationId: operation.operationId })
        shutdownTimer = setTimeout(() => {
          if (staged) rmSync(dirname(staged), { recursive: true, force: true })
          staged = null
          fail('Server shutdown did not finish. Check this host before retrying.')
        }, 60_000)
      } else if (message.type === 'solus:update' && supported && !updating) {
        updating = true
        previousVersion = basename(paths.installDir)
        operation = { ...message.operation, phase: 'downloading' }
        persist()
        publish()
        void (options.stage ?? stageServerRelease)(options.runtimeDir, paths.installDir, operation.version).then((next) => {
          if (stopping || child !== launched) {
            rmSync(dirname(next), { recursive: true, force: true })
            return
          }
          staged = next
          operation = { ...operation!, phase: 'waiting' }
          persist()
          publish()
        }).catch((error) => {
          if (!stopping && child === launched && updating) fail(error instanceof Error ? error.message : String(error))
        })
      }
    })
    let exited = false
    const onExit = (code: number | null) => {
      if (exited) return
      exited = true
      clearTimers()
      if (stopping) { finish(code ?? 1); return }
      if (candidate) {
        candidate = false
        restoreUpdateData(options.runtimeDir, options.dataDir)
        if (operation) {
          if (previousVersion) activateVersion(options.runtimeDir, previousVersion)
          removeVersion(options.runtimeDir, operation.version)
        }
        paths = runtimePaths(paths.dataDir, currentVersionDir(options.runtimeDir) ?? paths.installDir)
        fail('The new server did not start. The previous version was restored.')
        discardUpdateData(options.runtimeDir)
        launch()
      } else if (staged && operation && code === 0) {
        const next = staged
        staged = null
        try {
          snapshotUpdateData(options.runtimeDir, options.dataDir)
          finalizeStagedVersion(next, options.runtimeDir, operation.version)
          activateVersion(options.runtimeDir, operation.version)
          paths = runtimePaths(paths.dataDir, versionDir(options.runtimeDir, operation.version))
          candidate = true
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error))
        }
        launch()
      } else {
        if (updating) fail('The server stopped before the update could finish.')
        finish(code ?? 1)
      }
    }
    launched.once('error', () => onExit(1))
    launched.once('exit', onExit)
  }
  const stop = (signal: NodeJS.Signals) => {
    stopping = true
    if (child) child.kill(signal)
    else finish(0)
  }
  const sigterm = () => stop('SIGTERM')
  const sigint = () => stop('SIGINT')
  process.on('SIGTERM', sigterm)
  process.on('SIGINT', sigint)
  try { launch(); return await finished }
  finally {
    clearTimers()
    process.off('SIGTERM', sigterm)
    process.off('SIGINT', sigint)
    if (ownsLock) rmSync(lockPath, { force: true })
  }
}
