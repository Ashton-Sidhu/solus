import { open } from 'node:fs/promises'
import { z } from 'zod'
const READ_CHUNK_BYTES = 256 * 1024
const LINES_PER_TRANSACTION = 300
export const MAX_INDEXED_SESSION_LINE_BYTES = 4 * 1024 * 1024

const transcriptContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
})
const transcriptLineSchema = z.object({
  type: z.enum(['user', 'assistant']),
  message: z.object({
    content: z.union([z.string(), z.array(transcriptContentPartSchema)]),
    role: z.string().optional(),
  }),
  timestamp: z.union([z.string(), z.number()]),
  uuid: z.string().nullable().optional(),
})
export interface IndexedMessage {
  endOffset: number
  uuid: string | null
  role: string
  ts: number | null
  text: string
}


function extractMessage(line: string, endOffset: number): IndexedMessage | null {
  try {
    const parsed = transcriptLineSchema.safeParse(JSON.parse(line))
    if (!parsed.success) return null
    const obj = parsed.data

    const content = obj.message.content
    const text = Array.isArray(content)
      ? content
        .filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n')
      : content
    if (!text.trim()) return null

    const parsedTs = new Date(obj.timestamp).getTime()
    return {
      endOffset,
      uuid: obj.uuid ?? null,
      role: obj.message.role ?? obj.type,
      ts: Number.isFinite(parsedTs) ? parsedTs : null,
      text,
    }
  } catch {
    return null
  }
}

/**
 * Stream complete JSONL records from the unread portion of a transcript.
 *
 * A session can grow to hundreds of megabytes. Reading its entire unread tail
 * used to retain both that Buffer and a second array containing every parsed
 * line until indexing began. Chunking here bounds the reader's working set to
 * one 256 KiB block plus the current line; callers separately bound parsed
 * records to one database transaction.
 */
export async function* readTailRecordBatches(
  filePath: string,
  offset: number,
  size: number,
): AsyncGenerator<Array<{ endOffset: number; message: IndexedMessage | null }>> {
  const file = await open(filePath, 'r')
  let position = offset
  let pendingChunks: Buffer[] = []
  let pendingLength = 0
  let skippingOversizedLine = false
  let records: Array<{ endOffset: number; message: IndexedMessage | null }> = []

  const parseLine = (lineBuffer: Buffer, endOffset: number): IndexedMessage | null => {
    const withoutCarriageReturn = lineBuffer.at(-1) === 0x0d
      ? lineBuffer.subarray(0, lineBuffer.length - 1)
      : lineBuffer
    return extractMessage(withoutCarriageReturn.toString('utf8'), endOffset)
  }

  try {
    while (position < size) {
      const requestedBytes = Math.min(READ_CHUNK_BYTES, size - position)
      const buffer = Buffer.allocUnsafe(requestedBytes)
      const { bytesRead } = await file.read(buffer, 0, requestedBytes, position)
      if (bytesRead === 0) break

      const chunk = buffer.subarray(0, bytesRead)
      let lineStart = 0
      while (lineStart < chunk.length) {
        const newline = chunk.indexOf(0x0a, lineStart)
        if (skippingOversizedLine) {
          if (newline === -1) {
            lineStart = chunk.length
            break
          }
          const endOffset = position + newline + 1
          records.push({ endOffset, message: null })
          if (records.length >= LINES_PER_TRANSACTION) {
            yield records
            records = []
          }
          skippingOversizedLine = false
          lineStart = newline + 1
          continue
        }
        if (newline === -1) break

        const segment = chunk.subarray(lineStart, newline)
        const endOffset = position + newline + 1
        if (pendingLength + segment.length > MAX_INDEXED_SESSION_LINE_BYTES) {
          records.push({ endOffset, message: null })
        } else {
          const lineBuffer = pendingLength === 0
            ? segment
            : Buffer.concat([...pendingChunks, segment], pendingLength + segment.length)
          records.push({ endOffset, message: parseLine(lineBuffer, endOffset) })
        }
        if (records.length >= LINES_PER_TRANSACTION) {
          yield records
          records = []
        }
        pendingChunks = []
        pendingLength = 0
        lineStart = newline + 1
      }

      if (lineStart < chunk.length) {
        const remainder = chunk.subarray(lineStart)
        if (pendingLength + remainder.length > MAX_INDEXED_SESSION_LINE_BYTES) {
          pendingChunks = []
          pendingLength = 0
          skippingOversizedLine = true
        } else {
          pendingChunks.push(remainder)
          pendingLength += remainder.length
        }
      }
      position += bytesRead
    }

    if (!skippingOversizedLine && pendingLength > 0) {
      const lineBuffer = pendingChunks.length === 1
        ? pendingChunks[0]
        : Buffer.concat(pendingChunks, pendingLength)
      const endOffset = position
      const message = parseLine(lineBuffer, endOffset)
      if (message) {
        records.push({ endOffset, message })
      } else {
        const withoutCarriageReturn = lineBuffer.at(-1) === 0x0d
          ? lineBuffer.subarray(0, lineBuffer.length - 1)
          : lineBuffer
        try {
          JSON.parse(withoutCarriageReturn.toString('utf8'))
          records.push({ endOffset, message: null })
        } catch {
          // The agent may still be writing the final line. Leave the offset at
          // the preceding newline so the completed record is read next sweep.
        }
      }
    }
    if (records.length > 0) yield records
  } finally {
    await file.close()
  }
}

