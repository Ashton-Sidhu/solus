import type { RunManager } from '../../run/run-manager'
import type { SolusServer } from '../server'

export function registerRunHandlers(server: SolusServer, runManager: RunManager): void {
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
  server.register('runLogs', (args) => {
    const [cwd, commandId] = args as [string, string]
    return runManager.logs(cwd, commandId)
  })
}
