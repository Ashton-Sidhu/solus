/**
 * `solus update` drives the same host-owned transactional update RPCs
 * (`hostCheckForUpdates`/`hostInstallUpdate`/`hostUpdateStatus`) that a
 * connected desktop, web, or mobile client uses for Update Solus — there is
 * one update path, not a CLI-only shortcut (`docs/plans/host-and-provider-updates.md`).
 */
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import { requireRunningServerUrl, withLocalRpc } from './local-rpc'
import type { RuntimePaths } from './runtime'

const POLL_INTERVAL_MS = 1_000
const POLL_TIMEOUT_MS = 5 * 60_000

export async function runUpdate(paths: RuntimePaths, log: (line: string) => void): Promise<void> {
  const serverUrl = requireRunningServerUrl(paths)
  const status = await withLocalRpc<HostUpdateStatus>(serverUrl, (call) => call('hostCheckForUpdates'))
  if (status.serverUpdate && !status.serverUpdate.supported) {
    throw new Error(status.serverUpdate.reason ?? 'Remote updates are not supported on this host.')
  }
  if (status.check.kind === 'error') {
    throw new Error(`Could not check for a Solus update: ${status.check.message}`)
  }
  if (status.check.kind !== 'available') {
    log(`Solus ${status.currentVersion} is up to date.`)
    return
  }
  log(`Updating Solus ${status.currentVersion} to ${status.check.latestVersion}...`)
  const started = await withLocalRpc<HostUpdateStatus>(serverUrl, (call) => call('hostInstallUpdate'))
  const operation = started.serverUpdate?.operation
  if (!operation) throw new Error('The server did not acknowledge the update.')
  await pollUntilSettled(serverUrl, operation.operationId, operation.version, log)
}

async function pollUntilSettled(serverUrl: string, operationId: string, targetVersion: string, log: (line: string) => void): Promise<void> {
  let lastPhase: string | null = null
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    let status: HostUpdateStatus
    try {
      status = await withLocalRpc<HostUpdateStatus>(serverUrl, (call) => call('hostUpdateStatus'))
    } catch {
      // The server is mid-restart while it swaps in the new version.
      continue
    }
    const operation = status.serverUpdate?.operation
    if (!operation || operation.operationId !== operationId) continue
    if (operation.phase !== lastPhase) {
      lastPhase = operation.phase
      log(`  ${operation.phase}...`)
    }
    if (operation.phase === 'succeeded' && status.currentVersion === targetVersion) { log(`Updated Solus to ${operation.version}.`); return }
    if (operation.phase === 'failed') throw new Error(operation.message ?? 'The update failed.')
    if (operation.phase === 'cancelled') throw new Error('The update was cancelled.')
  }
  throw new Error('Timed out waiting for the update to finish. Check `solus status`.')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
