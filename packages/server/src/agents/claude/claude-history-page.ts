import { open } from 'node:fs/promises'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ProviderHistoryPage, SessionLoadMessage } from '@solus/contracts/session-history'
import { parseJsonlLine } from './claude-session-helpers'

const cursorSchema = z.object({
  offset: z.number().int().nonnegative(), inode: z.string(),
  anchorBytes: z.number().int().positive(), anchorHash: z.string(),
})
const BLOCK_BYTES = 64 * 1024

/** Read backwards from a byte boundary, decoding only complete UTF-8 lines.
 * Appending live messages cannot shift an older page's boundary. */
export async function loadClaudeHistoryPage(filePath: string, limit: number, before?: string): Promise<ProviderHistoryPage> {
  const file = await open(filePath, 'r')
  try {
    const stat = await file.stat()
    const cursor = before ? cursorSchema.parse(JSON.parse(before)) : null
    if (cursor && (cursor.inode !== String(stat.ino) || cursor.offset + cursor.anchorBytes > stat.size)) {
      throw new Error('Session history changed. Reopen the session to load earlier messages.')
    }
    if (cursor) {
      const anchor = Buffer.alloc(cursor.anchorBytes)
      await file.read(anchor, 0, anchor.length, cursor.offset)
      if (createHash('sha256').update(anchor).digest('hex') !== cursor.anchorHash) {
        throw new Error('Session history changed. Reopen the session to load earlier messages.')
      }
    }
    let position = cursor?.offset ?? stat.size
    let fragments: Buffer[] = []
    const messages: SessionLoadMessage[] = []
    while (position > 0) {
      const start = Math.max(0, position - BLOCK_BYTES)
      const block = Buffer.alloc(position - start)
      const { bytesRead } = await file.read(block, 0, block.length, start)
      if (bytesRead !== block.length) throw new Error('Session history changed during loading.')
      let end = block.length
      for (let index = block.length - 1; index >= 0; index--) {
        if (block[index] !== 10) continue
        const head = block.subarray(index + 1, end)
        const line = fragments.length ? Buffer.concat([head, ...fragments.reverse()]) : head
        fragments = []
        const message = parseJsonlLine(line.toString('utf8'))
        end = index
        if (!message) continue
        messages.push(message)
        if (messages.length >= limit && message.role === 'user' && !message.parentToolUseId) {
          return {
            messages: messages.reverse(),
            before: JSON.stringify({
              offset: start + index + 1, inode: String(stat.ino), anchorBytes: line.length,
              anchorHash: createHash('sha256').update(line).digest('hex'),
            }),
          }
        }
      }
      if (end > 0) fragments.push(block.subarray(0, end))
      position = start
    }
    const first = parseJsonlLine(Buffer.concat(fragments.reverse()).toString('utf8'))
    if (first) messages.push(first)
    return { messages: messages.reverse(), before: null }
  } finally {
    await file.close()
  }
}
