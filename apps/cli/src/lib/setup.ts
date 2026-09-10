import { hostForUrl } from '@solus/contracts/entrypoint'
import { isManagedVersion } from '@solus/contracts/host-install'
import { defaultBinDir, defaultRuntimeDir, isProcessAlive, localConnectHost, readLockFile, type RuntimePaths } from './runtime'
import { defaultServiceExec, installService, serviceStatus, type ServiceEnv } from './service'
import { homedir } from 'node:os'

export function serviceEnvFor(paths: RuntimePaths, binDir = defaultBinDir()): ServiceEnv {
  return { dataDir: paths.dataDir, runtimeDir: defaultRuntimeDir(), host: process.env.SOLUS_HOST, port: process.env.SOLUS_PORT, home: homedir(), binDir, logFile: paths.logFile, platform: process.platform, exec: defaultServiceExec }
}

/** Installs and starts the native service, then waits for the server it
 *  starts to answer `/health` before handing control back. */
export async function runSetup(paths: RuntimePaths, log: (line: string) => void): Promise<void> {
  if (!isManagedVersion(paths.installDir)) {
    throw new Error(`No Solus installation was found at ${paths.installDir}. Run the installer first.`)
  }
  const env = serviceEnvFor(paths)
  const existing = readLockFile(paths.lockFile)
  if (existing && isProcessAlive(existing.pid) && !serviceStatus(env).active) {
    throw new Error('A foreground Solus server is already running. Stop it before installing the service.')
  }
  log(env.platform === 'linux' ? 'Installing the systemd user service...' : 'Installing the launchd service...')
  const { lingerAdvice } = installService(env)
  if (lingerAdvice) log(lingerAdvice)

  log('Waiting for the server to become healthy...')
  await waitForHealth(paths, 20_000)
  if (!serviceStatus(env).active) throw new Error('The server answered, but the Solus service is not running. Check solus status.')
  log('Solus server is running.')
  log('Connect a client with `solus pair`, or link this host with `solus connect`.')
}

async function waitForHealth(paths: RuntimePaths, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: string | null = null
  while (Date.now() < deadline) {
    const lock = readLockFile(paths.lockFile)
    if (lock && isProcessAlive(lock.pid)) {
      try {
        const response = await fetch(`http://${hostForUrl(localConnectHost(lock.host))}:${lock.port}/health`, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) return
        lastError = `/health returned HTTP ${response.status}`
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Solus did not become healthy within ${Math.round(timeoutMs / 1000)}s${lastError ? `: ${lastError}` : ''}. Check \`solus logs\`.`)
}
