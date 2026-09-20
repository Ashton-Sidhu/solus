import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Principal } from '../server/principal'
import { organizationOf } from '../server/principal'
import { getSessionRecord } from '../sessions/session-records'
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
export const sharedPromptPollSchema = z.object({ hostId: z.string() })
export const sharedPromptPollResponseSchema = z.object({ commands: z.array(sharedPromptCommandSchema) })
export const sharedPromptResultSchema = z.object({ hostId: z.string(), requestId: z.string(), error: z.string().nullable() })
export const sharedPromptAckSchema = z.object({ ok: z.boolean() })
export type SharedPromptCommand = z.infer<typeof sharedPromptCommandSchema>
export type SharedPromptPoll = z.infer<typeof sharedPromptPollSchema>
export type SharedPromptResult = z.infer<typeof sharedPromptResultSchema>
type Runner = Extract<Principal, { kind: 'runner' }>

interface PendingPrompt {
  organizationId: string
  hostId: string
  principal: Extract<Principal, { kind: 'guest' }>
  command: SharedPromptCommand
  sent: boolean
  finish(error: string | null): void
}

/** Live request forwarding only. No accepted prompt is stored on the service.
 * The caller waits for the runner's receipt; a stopped runner refuses immediately.
 * A lost receipt has an explicit uncertain result and is never retried here. */
export class SharedPromptRelay {
  private readonly pending = new Map<string, PendingPrompt>()
  private readonly seen = new Map<string, number>()
  constructor(private readonly shares: ShareManager) {}

  async available(principal: Principal, sessionId: string): Promise<boolean> {
    await this.shares.assertRole(principal, { kind: 'session', id: sessionId }, 'viewer')
    const organizationId = organizationOf(principal)
    const record = await getSessionRecord(organizationId, sessionId)
    return !!record?.runnerHostId && Date.now() - (this.seen.get(`${organizationId}:${record.runnerHostId}`) ?? 0) <= 6_000
  }

  async prompt(principal: Principal, request: z.infer<typeof sharedPromptRequestSchema>): Promise<{ accepted: true }> {
    if (principal.kind !== 'guest') throw new Error('This action is for a shared session visitor.')
    await this.shares.assertRole(principal, { kind: 'session', id: request.sessionId }, 'editor')
    const organizationId = organizationOf(principal)
    const record = await getSessionRecord(organizationId, request.sessionId)
    if (!record?.runnerHostId || Date.now() - (this.seen.get(`${organizationId}:${record.runnerHostId}`) ?? 0) > 6_000) {
      throw new Error('This session’s runner is offline. No prompt was sent.')
    }
    if (this.pending.size >= 100 || [...this.pending.values()].some((item) => item.principal.guestId === principal.guestId)) {
      throw new Error('A prompt is already being sent. Wait for its result.')
    }
    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = this.pending.get(requestId)
        this.pending.delete(requestId)
        reject(new Error(item?.sent ? 'The runner did not confirm receipt. Check the transcript before sending again.' : 'The runner disconnected. No prompt was sent.'))
      }, 12_000)
      this.pending.set(requestId, {
        organizationId, hostId: record.runnerHostId!, principal, sent: false,
        command: { ...request, requestId, expiresAt: Date.now() + 10_000, actor: { userId: principal.accountUserId ?? `guest:${principal.guestId}`, seatUserId: principal.accountUserId ?? principal.share.sharedByUserId, displayName: principal.displayName } },
        finish: (error) => { clearTimeout(timer); this.pending.delete(requestId); if (error) reject(new Error(error)); else resolve() },
      })
    })
    return { accepted: true }
  }

  async poll(runner: Runner): Promise<z.infer<typeof sharedPromptPollResponseSchema>> {
    const now = Date.now()
    for (const [key, at] of this.seen) if (now - at > 60_000) this.seen.delete(key)
    this.seen.set(`${runner.organizationId}:${runner.hostId}`, now)
    const commands: SharedPromptCommand[] = []
    for (const item of this.pending.values()) {
      if (item.organizationId !== runner.organizationId || item.hostId !== runner.hostId || item.sent) continue
      if (item.command.expiresAt <= now || item.principal.expiresAt <= now) { item.finish('The request expired. No prompt was sent.'); continue }
      if (await this.shares.roleFor(item.principal, { kind: 'session', id: item.command.sessionId }) !== 'editor') {
        item.finish('This link no longer permits prompts.'); continue
      }
      item.sent = true
      commands.push(item.command)
    }
    return { commands }
  }

  result(runner: Runner, result: SharedPromptResult) {
    const item = this.pending.get(result.requestId)
    if (!item || !item.sent || item.organizationId !== runner.organizationId || item.hostId !== runner.hostId) return { ok: false }
    item.finish(result.error)
    return { ok: true }
  }
}
