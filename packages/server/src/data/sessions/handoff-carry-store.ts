import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { NormalizedEvent, SessionStatus } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

const carrySchema = z.object({
  status: z.enum(['interrupted', 'failed', 'dead', 'rate_limited']),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string(), timestamp: z.number() })),
})
type HandoffCarry = z.infer<typeof carrySchema>

/** Public text from an incomplete turn can outlive its provider process.
 * Private reasoning, tools, child output, and attachments never enter this file. */
export class HandoffCarryStore {
  private readonly entries = new Map<string, HandoffCarry>()
  constructor(private readonly directory?: string) {}

  get(threadId: string): HandoffCarry | undefined {
    const cached = this.entries.get(threadId)
    if (cached || !this.directory) return cached
    try {
      const carry = carrySchema.parse(JSON.parse(readFileSync(this.path(threadId), 'utf8')))
      this.entries.set(threadId, carry)
      return carry
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  settle(threadId: string, status: SessionStatus, events: NormalizedEvent[], at: number): void {
    if (status !== 'interrupted' && status !== 'failed' && status !== 'dead' && status !== 'rate_limited') {
      this.entries.delete(threadId)
      if (this.directory) rmSync(this.path(threadId), { force: true })
      return
    }
    const messages: HandoffCarry['messages'] = []
    for (const event of events) {
      if (event.type === 'user_message') messages.push({ role: 'user', content: event.text, timestamp: at })
      else if (event.type === 'text_chunk' && !event.parentToolUseId) {
        const previous = messages.at(-1)
        if (previous?.role === 'assistant') previous.content += event.text
        else messages.push({ role: 'assistant', content: event.text, timestamp: at })
      }
    }
    const carry = { status, messages }
    if (this.directory) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const file = this.path(threadId)
      writeFileSync(`${file}.pending`, JSON.stringify(carry), { mode: 0o600 })
      renameSync(`${file}.pending`, file)
    }
    this.entries.set(threadId, carry)
  }

  /** Native history wins when it already contains the visible partial reply. */
  merge(threadId: string, messages: SessionLoadMessage[]): SessionLoadMessage[] {
    const carry = this.get(threadId)
    if (!carry) return messages
    const missing = carry.messages.filter((item) => item.content.trim() && !messages.some((native) => native.role === item.role && native.content.includes(item.content)))
    return missing.length ? [...messages, ...missing] : messages
  }

  private path(threadId: string): string {
    return join(this.directory!, `${createHash('sha256').update(threadId).digest('hex')}.json`)
  }
}
