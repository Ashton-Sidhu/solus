import type { ConnectionStatus } from './ws-transport'

export interface ConnectionDisplayOptions {
  attempt?: number
  hasConnected?: boolean
}

export function presentedConnectionStatus(
  status: ConnectionStatus,
  { attempt = 0, hasConnected = false }: ConnectionDisplayOptions = {},
): ConnectionStatus {
  if (status === 'reconnecting' && !hasConnected && attempt <= 1) return 'connecting'
  return status
}

export function connectionStatusLabel(
  status: ConnectionStatus,
  { attempt = 0, hasConnected = false }: ConnectionDisplayOptions = {},
): string {
  const presented = presentedConnectionStatus(status, { attempt, hasConnected })
  if (presented === 'connected') return 'Connected'
  if (presented === 'blocked') return 'Sign-in required'
  if (presented === 'reconnecting') {
    return attempt > 0 ? `Reconnecting (attempt ${attempt})...` : 'Reconnecting...'
  }
  if (presented === 'connecting') {
    return attempt > 1 ? `Connecting (attempt ${attempt})...` : 'Connecting...'
  }
  return 'Disconnected'
}
