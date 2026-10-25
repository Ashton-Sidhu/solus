/**
 * `solus logs` with Node only, so it works where there is no `tail` (Windows).
 */
import { closeSync, openSync, readSync, statSync, unwatchFile, watchFile, type Stats } from 'node:fs'

const CHUNK_BYTES = 64 * 1024

function readRange(file: string, start: number, end: number): Buffer {
  const buffer = Buffer.alloc(end - start)
  const fd = openSync(file, 'r')
  try {
    let read = 0
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, start + read)
      if (count === 0) break
      read += count
    }
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/** The last `count` lines and the byte offset where the file ends. It reads
 *  back from the end, so a large log costs only the bytes it shows. */
export function readLastLines(file: string, count: number) {
  const end = statSync(file).size
  let start = end
  let tail = Buffer.alloc(0)
  // One more newline than lines is enough: a trailing newline ends the last line.
  while (start > 0 && tail.filter((byte) => byte === 0x0a).length <= count) {
    const from = Math.max(0, start - CHUNK_BYTES)
    tail = Buffer.concat([readRange(file, from, start), tail])
    start = from
  }
  let remaining = count
  let index = tail.at(-1) === 0x0a ? tail.length - 2 : tail.length - 1
  for (; index >= 0; index--) {
    if (tail[index] === 0x0a && --remaining === 0) break
  }
  return { text: tail.subarray(index + 1), end }
}

/** Writes each block appended after `from`. When the file becomes shorter
 *  (it was replaced or started again), it reads from the start. Returns stop. */
export function followFile(file: string, from: number, write: (chunk: Buffer) => void, intervalMs = 500): () => void {
  let position = from
  const listener = (current: Stats) => {
    if (current.size < position) position = 0
    if (current.size === position) return
    const chunk = readRange(file, position, current.size)
    position += chunk.length
    if (chunk.length > 0) write(chunk)
  }
  watchFile(file, { interval: intervalMs }, listener)
  return () => unwatchFile(file, listener)
}
