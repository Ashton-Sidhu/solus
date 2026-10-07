import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Principal } from '../admission/principal'
import { recordScopeOf } from '../admission/principal'
import { getSessionRecord } from '../data/sessions/session-records'
import type { ShareManager } from './share-manager'

export const sharedPromptRequestSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().trim().min(1).max(100_000),
})
export const sharedPromptCommandSchema = sharedPromptRequestSchema.extend({
  requestId: z.string(),
  expiresAt: z.number(),
  actor: z.object({ userId: z.string(), seatUserId: z.string(), displayName: z.string() }),
})
/** What the runner acknowledges a command with: null when the prompt was dispatched. */
export const sharedPromptReceiptSchema = z.object({ error: z.string().nullable() })
export type SharedPromptCommand = z.infer<typeof sharedPromptCommandSchema>
export type SharedPromptReceipt = z.infer<typeof sharedPromptReceiptSchema>

/** The event a command travels on, down the runner's socket to the Solus API. */
export const SHARED_PROMPT_EVENT = 'shared-prompt'
/** How long a command stays dispatchable on the runner. */
const COMMAND_TTL_MS = 10_000
/** How long the service waits for the runner's receipt. */
const RECEIPT_TIMEOUT_MS = 12_000
const MAX_IN_FLIGHT = 100

/** Sends a command down a runner's socket and resolves with its receipt (`WebSocketTransport.request`). */
export type RunnerRequest = (clientId: string, event: typeof SHARED_PROMPT_EVENT, command: SharedPromptCommand, receipt: typeof sharedPromptReceiptSchema, timeoutMs: number) => Promise<SharedPromptReceipt>

/** Live request forwarding only. No accepted prompt is stored on the service.
 * A command goes down the socket the runner holds open to the service, and the
 * caller waits for the runner's receipt; a runner without a socket refuses
 * immediately. A lost receipt has an explicit uncertain result and is never retried here. */
export class SharedPromptRelay {
  /** `organizationId:hostId` → the runner's socket client ids, oldest first. */
  private readonly runners = new Map<string, string[]>()
  private readonly inFlight = new Set<string>()
  /** `request` is the live transport the commands travel on. */
  constructor(private readonly shares: ShareManager, private readonly request: RunnerRequest) {}

  runnerConnected(clientId: string, principal: Principal): void {
    if (principal.kind !== 'runner') return
    const key = runnerKey(principal.organizationId, principal.hostId)
    this.runners.set(key, [...(this.runners.get(key) ?? []).filter(id => id !== clientId), clientId])
  }

  runnerDisconnected(clientId: string): void {
    for (const [key, clientIds] of this.runners) {
      const remaining = clientIds.filter(id => id !== clientId)
      if (remaining.length) this.runners.set(key, remaining)
      else this.runners.delete(key)
    }
  }

  async available(principal: Principal, sessionId: string): Promise<boolean> {
    await this.shares.assertRole(principal, { kind: 'session', id: sessionId }, 'viewer')
    const record = await getSessionRecord(recordScopeOf(principal), sessionId)
    return !!record?.runnerHostId && !!this.runnerFor(record.organizationId, record.runnerHostId)
  }

  async prompt(principal: Principal, request: z.infer<typeof sharedPromptRequestSchema>): Promise<{ accepted: true }> {
    if (principal.kind !== 'guest') throw new Error('This action is for a shared session visitor.')
    await this.shares.assertRole(principal, { kind: 'session', id: request.sessionId }, 'editor')
    const record = await getSessionRecord(recordScopeOf(principal), request.sessionId)
    const clientId = record?.runnerHostId ? this.runnerFor(record.organizationId, record.runnerHostId) : undefined
    if (!clientId) throw new Error('This session’s runner is offline. No prompt was sent.')
    if (this.inFlight.size >= MAX_IN_FLIGHT || this.inFlight.has(principal.guestId)) {
      throw new Error('A prompt is already being sent. Wait for its result.')
    }
    const command: SharedPromptCommand = {
      ...request,
      requestId: randomUUID(),
      expiresAt: Date.now() + COMMAND_TTL_MS,
      actor: { userId: principal.accountUserId ?? `guest:${principal.guestId}`, seatUserId: principal.accountUserId ?? principal.share.sharedByUserId, displayName: principal.displayName },
    }
    this.inFlight.add(principal.guestId)
    let receipt: SharedPromptReceipt
    try {
      receipt = await this.request(clientId, SHARED_PROMPT_EVENT, command, sharedPromptReceiptSchema, RECEIPT_TIMEOUT_MS)
    } catch {
      throw new Error('The runner did not confirm receipt. Check the transcript before sending again.')
    } finally {
      this.inFlight.delete(principal.guestId)
    }
    if (receipt.error) throw new Error(receipt.error)
    return { accepted: true }
  }

  private runnerFor(organizationId: string, hostId: string): string | undefined {
    return this.runners.get(runnerKey(organizationId, hostId))?.at(-1)
  }
}

function runnerKey(organizationId: string, hostId: string): string {
  return `${organizationId}:${hostId}`
}
