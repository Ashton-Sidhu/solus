import type { ConnectionStatus } from './ws-transport'

export interface ConnectionTarget {
  id: string
  label: string
  url: string
  sessionToken: string
  installationId?: string
  local: boolean
}

export interface ConnectionState {
  status: ConnectionStatus
  attempt: number
  target?: ConnectionTarget
}

type ConnectionStateSubscriber = (state: ConnectionState) => void

export let connectionState: ConnectionState = { status: 'disconnected', attempt: 0 }
const subscribers = new Set<ConnectionStateSubscriber>()

export function subscribe(subscriber: ConnectionStateSubscriber): () => void {
  subscribers.add(subscriber)
  subscriber(connectionState)
  return () => subscribers.delete(subscriber)
}

export function setConnectionState(state: ConnectionState): void {
  connectionState = state
  for (const subscriber of subscribers) subscriber(connectionState)
}
