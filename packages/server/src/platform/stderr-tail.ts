import type { Stream } from 'node:stream'

/** The last characters a child process wrote to standard error, kept in memory only. It is never logged; a log has its size. */
export class StderrTail {
  private text = ''
  /** Every byte the process wrote, for the log. */
  bytes = 0

  constructor(stream: Stream | null, private readonly maxLength: number) {
    // A pipe nobody reads fills up and stops the child, so the tail always reads it.
    stream?.on('data', (chunk: Buffer | string) => {
      this.bytes += Buffer.byteLength(chunk)
      this.text = (this.text + chunk.toString()).slice(-this.maxLength)
    })
  }

  get tail(): string | undefined {
    return this.text.trim() ? this.text : undefined
  }
}
