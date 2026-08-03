import type { RunManager } from '../../run/run-manager'
import type { RunLogSubscriptions } from '../../run/run-log-subscriptions'
import type { SolusServer } from '../server'

export function registerRunHandlers(
  server: SolusServer,
  runManager: RunManager,
  subscriptions: RunLogSubscriptions,
): void {
  server.register('runStatus', (args) => {
    const [cwd] = args as [string]
    return runManager.status(cwd)
  })
  server.register('runStart', (args) => {
    const [cwd, commandId] = args as [string, string]
    return runManager.start(cwd, commandId)
  })
  server.register('runStop', (args) => {
    const [cwd, commandId] = args as [string, string]
    return runManager.stop(cwd, commandId)
  })
  server.register('runRestart', (args) => {
    const [cwd, commandId] = args as [string, string]
    return runManager.restart(cwd, commandId)
  })
  server.register('runLogsRetain', async (args, handlerCtx) => {
    const [cwd, commandId] = args as [string, string]
    if (!handlerCtx.clientId) throw new Error('Run log retention requires a client id')
    const repoRoot = await runManager.resolveRepoRoot(cwd)
    subscriptions.retain(handlerCtx.clientId, repoRoot, commandId)
    const lines = await runManager.logs(cwd, commandId)
    return { repoRoot, lines }
  })
  server.register('runLogsRelease', (args, handlerCtx) => {
    const [repoRoot, commandId] = args as [string, string]
    if (handlerCtx.clientId) subscriptions.release(handlerCtx.clientId, repoRoot, commandId)
  })
}
