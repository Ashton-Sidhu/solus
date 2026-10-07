import { z } from 'zod'

/** Answers remembered per account. A REST GET is only worth remembering when
 *  it is read again, so the oldest answer goes first. */
const MAX_ENTRIES = 200
/** A larger text body, such as a big diff, is not worth holding in memory. */
const MAX_TEXT_LENGTH = 1_000_000

const notModifiedSchema = z.object({ status: z.literal(304) })
const largeTextSchema = z.string().min(MAX_TEXT_LENGTH + 1)

export interface ConditionalResponse {
  headers: { etag?: string }
  data: unknown
}

/**
 * Revalidate repeated REST reads with `If-None-Match`. GitHub answers 304
 * when nothing changed, and a 304 does not count against the quota, so a
 * repeated read of an unchanged list or pull request is free. Octokit
 * throws a 304 as a request error; the remembered answer replaces it.
 */
export class ConditionalReads<Response extends ConditionalResponse> {
  private readonly entries = new Map<string, { etag: string; response: Response }>()

  async read(key: string, send: (etag: string | null) => Promise<Response>): Promise<Response> {
    const remembered = this.entries.get(key)
    try {
      const response = await send(remembered?.etag ?? null)
      this.remember(key, response)
      return response
    } catch (error) {
      if (!remembered || !notModifiedSchema.safeParse(error).success) throw error
      // Most recently used goes last.
      this.entries.delete(key)
      this.entries.set(key, remembered)
      return structuredClone(remembered.response)
    }
  }

  private remember(key: string, response: Response): void {
    this.entries.delete(key)
    const etag = response.headers.etag
    if (!etag || largeTextSchema.safeParse(response.data).success) return
    // A copy, so a caller that changes its answer does not change the next one.
    this.entries.set(key, { etag, response: structuredClone(response) })
    const oldest = this.entries.keys().next()
    if (this.entries.size > MAX_ENTRIES && !oldest.done) this.entries.delete(oldest.value)
  }
}
