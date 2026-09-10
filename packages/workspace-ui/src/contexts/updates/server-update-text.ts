import { isServerUpdateActive, type ServerUpdateOperation } from '@solus/contracts/server-update'

export function serverUpdateText(operation: ServerUpdateOperation, host: string, connected = true): string {
  if (!connected && isServerUpdateActive(operation)) return `Waiting to reconnect to ${host}…`
  switch (operation.phase) {
    case 'waiting': return `Waiting for active work on ${host}…`
    case 'downloading': return `Updating Solus on ${host}…`
    case 'restarting': return `Restarting Solus on ${host}…`
    case 'succeeded': return `Solus on ${host} updated to ${operation.version}`
    case 'failed': return `Solus update failed on ${host}`
    case 'cancelled': return `Solus update cancelled on ${host}`
  }
}
