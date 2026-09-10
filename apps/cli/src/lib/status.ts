import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { UplinkStatus } from '@solus/contracts/uplink'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import { readReleaseManifest } from './server-release'
import { withLocalRpc } from './local-rpc'
import { isProcessAlive, localConnectHost, readLockFile, type RuntimePaths } from './runtime'
import { serviceEnvFor } from './setup'
import { hasServiceDefinition, serviceStatus } from './service'
import { hostForUrl } from '@solus/contracts/entrypoint'

export async function reportStatus(paths: RuntimePaths, log: (line: string) => void): Promise<void> {
  const manifestPath = join(paths.installDir, 'server-release.json')
  const version = existsSync(manifestPath) ? readReleaseManifest(paths.installDir).version : null
  log(`Installed version: ${version ?? 'unknown'} (${paths.installDir})`)

  const lock = readLockFile(paths.lockFile)
  const running = !!lock && isProcessAlive(lock.pid)
  log(`Server: ${running ? `running (pid ${lock!.pid}, http://${hostForUrl(localConnectHost(lock!.host))}:${lock!.port})` : 'not running'}`)

  reportService(paths, log)

  if (!running) return
  try {
    const serverUrl = `http://${hostForUrl(localConnectHost(lock!.host))}:${lock!.port}`
    const status = await withLocalRpc<HostUpdateStatus>(serverUrl, (call) => call('hostUpdateStatus'))
    log(`Running version: ${status.currentVersion}${status.check.kind === 'available' ? ` (${status.check.latestVersion} available)` : ''}`)
    const operation = status.serverUpdate?.operation
    if (operation) log(`Update: ${operation.phase} (${operation.version})${operation.message ? ` — ${operation.message}` : ''}`)
    const link = await withLocalRpc<UplinkStatus>(serverUrl, (call) => call('uplinkStatus'))
    log(`Solus Cloud: ${link.linked ? link.state.observed : 'not linked'}`)
    for (const provider of status.providers) {
      log(`  ${provider.agent}: ${provider.installedVersion ?? 'not installed'}${provider.check.kind === 'available' ? ` (${provider.check.latestVersion} available)` : ''}`)
    }
  } catch (error) {
    log(`  Could not read live status: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function reportService(paths: RuntimePaths, log: (line: string) => void): void {
  if (process.platform === 'linux' || process.platform === 'darwin') {
    if (!hasServiceDefinition(serviceEnvFor(paths).home, process.platform)) {
      log('Service: not installed — run `solus setup` to run Solus in the background.')
    } else {
      const svc = serviceStatus(serviceEnvFor(paths))
      log(`Service: ${svc.active ? 'active' : svc.enabled ? 'enabled, not running' : 'installed, disabled'}`)
      if (!svc.active) log('  Start or repair with `solus setup`; inspect `solus logs` if startup fails.')
      if (svc.detail) log(`  ${svc.detail}`)
    }
  }

}
