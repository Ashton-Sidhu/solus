import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { historyPageIsFull, historyPageMustCut, startsHistoryTurn, type ProviderHistoryPage, type SessionLoadMessage } from '@solus/contracts/session-history'
import { parseJsonlLine } from './claude-session-helpers'

const cursorSchema = z.object({
  offset: z.number().int().nonnegative(), inode: z.string(),
  anchorBytes: z.number().int().positive(), anchorHash: z.string(),
})
/** Each read doubles from the first block to the largest. A short page stays
 *  one small read; a page of many megabytes needs a few awaits, not hundreds,
 *  and each await waits behind every other task on a busy host. */
const FIRST_BLOCK_BYTES = 64 * 1024
const MAX_BLOCK_BYTES = 2 * 1024 * 1024

/** Stored bytes one page may read inside a turn. Tool output the transcript
 *  does not return can make a line far larger than its row. */
const TURN_READ_BYTES = 16 * 1024 * 1024

/** Read backwards from a byte boundary, decoding only complete UTF-8 lines,
 * until `turnLimit` user turns are complete or the page is full at a turn
 * start; then the cursor is the line the page starts at. A turn past the hard
 * budget, or past `TURN_READ_BYTES` read, is cut inside. Appending live
 * messages cannot shift an older page's boundary. */
export async function loadClaudeHistoryPage(filePath: string, turnLimit: number, before?: string): Promise<ProviderHistoryPage> {
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
    let turns = 0
    let lineBytes = 0
    let bytes = 0
    let blockBytes = FIRST_BLOCK_BYTES
    while (position > 0) {
      const start = Math.max(0, position - blockBytes)
      blockBytes = Math.min(MAX_BLOCK_BYTES, blockBytes * 2)
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
        lineBytes += line.length
        if (!message) continue
        messages.push(message)
        bytes += Buffer.byteLength(JSON.stringify(message))
        const pageEnds = startsHistoryTurn(message) && (++turns >= turnLimit || historyPageIsFull(messages.length, bytes))
        if (pageEnds || historyPageMustCut(messages.length, bytes) || lineBytes >= TURN_READ_BYTES) {
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

/** The rows from the start of the file through its first turn. Lines are read
 *  forward and the read stops where the second turn starts, so the rest of the
 *  file is never parsed. */
export async function loadClaudeFirstTurn(filePath: string): Promise<SessionLoadMessage[]> {
  const input = createReadStream(filePath, { highWaterMark: FIRST_BLOCK_BYTES })
  const lines = createInterface({ input, crlfDelay: Infinity })
  const messages: SessionLoadMessage[] = []
  let turnStarted = false
  try {
    for await (const line of lines) {
      const message = parseJsonlLine(line)
      if (!message) continue
      if (startsHistoryTurn(message)) {
        if (turnStarted) break
        turnStarted = true
      }
      messages.push(message)
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return messages
}
