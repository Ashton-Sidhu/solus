import { z } from 'zod'

/**
 * Resource watches (docs/plans/mcp-first-class.md §11.5): one session's
 * subscription to one MCP resource. A change starts the agent again, once for
 * a burst of changes. A client gets Solus's id, never a subscription id of the
 * server.
 */

/**
 * `starting`: the subscription opens, or opens again after the stream ended.
 * `watching`: open, and no change waits. `changed`: a change waits to start the
 * agent (after the running turn, or after the minimum time between two starts).
 * `needs-sign-in` and `unreachable`: the subscription could not open; the host
 * tries again. `ended`: `endReason` says why.
 */
export const RESOURCE_WATCH_STATES = ['starting', 'watching', 'changed', 'needs-sign-in', 'unreachable', 'ended'] as const
export type ResourceWatchState = (typeof RESOURCE_WATCH_STATES)[number]

/**
 * `stopped`: the person stopped it. `agent`: the agent stopped it
 * (`watching: false`). `limit`: it started the agent its maximum number of
 * times. `expired`: its lifetime ended. `host-restarted`: a command's process
 * did not survive a restart of the host. `server-stopped`: the command's
 * process stopped. `session-archived`: the person archived the session.
 * `removed`: the MCP server was removed. `refused`: the server did not take the
 * subscription.
 */
export const RESOURCE_WATCH_END_REASONS = ['stopped', 'agent', 'limit', 'expired', 'host-restarted', 'server-stopped', 'session-archived', 'removed', 'refused'] as const
export type ResourceWatchEndReason = (typeof RESOURCE_WATCH_END_REASONS)[number]

export interface ResourceWatch {
  id: string
  sessionId: string
  integrationName: string
  uri: string
  /** The resource's name as the server listed it, else its URI. */
  name: string
  state: ResourceWatchState
  /** Set when `state` is `ended`. */
  endReason?: ResourceWatchEndReason
  /** Solus's own words about the state, or the server's error. Plain text. */
  message?: string
  /** How many times a change started the agent. */
  wakes: number
  createdAt: number
  updatedAt: number
  expiresAt: number
}

export function resourceWatchIsLive(watch: Pick<ResourceWatch, 'state'>): boolean {
  return watch.state !== 'ended'
}

export const integrationResourceWatchListRequestSchema = z.object({ sessionId: z.string().min(1) })
export type IntegrationResourceWatchListRequest = z.infer<typeof integrationResourceWatchListRequestSchema>

/** `sessionId` names the session that access is checked for; the host refuses a watch of another session. */
export const integrationResourceWatchStopRequestSchema = z.object({ sessionId: z.string().min(1), id: z.string().min(1) })
export type IntegrationResourceWatchStopRequest = z.infer<typeof integrationResourceWatchStopRequestSchema>

export interface ResourceWatchChangedEvent {
  sessionId: string
  watch: ResourceWatch
}

/**
 * The message that starts the agent after a change. A history row keeps no
 * origin, so a client knows the message by its first line
 * (`resourceWatchWake`). `label` is "<server> · <resource name>".
 */
export function resourceWatchWakeHeader(label: string): string {
  return `A watched MCP resource changed: ${label}`
}

const WAKE_HEADER = /^A watched MCP resource changed: (.+)$/

export interface ResourceWatchWake {
  label: string
  /** The rest of the message: the contents, or why Solus could not read them. */
  body: string
}

/** The resource watch wake this prompt is, or null. Reads the first line before it commits. */
export function resourceWatchWake(text: string): ResourceWatchWake | null {
  const trimmed = text.trimStart()
  const lineEnd = trimmed.indexOf('\n')
  const header = WAKE_HEADER.exec(lineEnd === -1 ? trimmed : trimmed.slice(0, lineEnd))
  if (!header) return null
  return { label: header[1]!, body: lineEnd === -1 ? '' : trimmed.slice(lineEnd + 1).trim() }
}
