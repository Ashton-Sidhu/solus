import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionRepositoryBundleChunkResult, SessionRepositoryBundleResult } from '@solus/contracts/rpc'
import type { SessionRepositories } from './session-repository'

const CHUNK_BYTES = 1024 * 1024
const IDLE_MS = 10 * 60_000

/** The host route that streams the file of one transfer: `<prefix><transferId>`. */
export const SESSION_BUNDLE_ROUTE_PREFIX = '/session-bundles/'
/** Only this route sends this type. A host that answers with a different type does not have the route. */
export const SESSION_BUNDLE_CONTENT_TYPE = 'application/x-git-bundle'

interface Transfer {
  sessionId: string
  path: string
  folder: string
  size: number
  principalKey: string
  /** SHA-256 of the download secret. The secret itself is not kept. */
  secretHash: Buffer
  timer: ReturnType<typeof setTimeout>
}

export type SessionBundleDownload =
  | { kind: 'stream'; size: number; start: number; stream: ReadStream }
  | { kind: 'refused' }
  | { kind: 'bad-range'; size: number }

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

/** Short-lived files for a binary repository transfer: one HTTP stream, or bounded RPC calls for an older peer. */
export class SessionBundleTransfers {
  private readonly transfers = new Map<string, Transfer>()

  constructor(private readonly repositories: SessionRepositories) {}

  async start(sessionId: string, repository: string, have: string | null, principalKey: string): Promise<SessionRepositoryBundleResult> {
    const folder = await mkdtemp(join(tmpdir(), 'solus-session-bundle-'))
    const path = join(folder, 'repository.bundle')
    try {
      const result = await this.repositories.named(repository).bundleSince(have, path)
      if (result.kind !== 'written') {
        await rm(folder, { recursive: true, force: true })
        if (result.kind === 'current' && !result.head) return { state: 'no-repository' }
        return { state: result.kind, head: result.head }
      }
      const transferId = randomUUID()
      const size = (await stat(path)).size
      const downloadSecret = randomBytes(32).toString('base64url')
      const timer = setTimeout(() => { void this.remove(transferId) }, IDLE_MS)
      timer.unref()
      this.transfers.set(transferId, { sessionId, path, folder, size, principalKey, secretHash: hashSecret(downloadSecret), timer })
      return { state: 'ready', transferId, size, head: result.head, downloadSecret }
    } catch (error) {
      await rm(folder, { recursive: true, force: true })
      throw error
    }
  }

  sessionOf(transferId: string, principalKey: string): string | null {
    const transfer = this.transfers.get(transferId)
    return transfer?.principalKey === principalKey ? transfer.sessionId : null
  }

  async chunk(transferId: string, offset: number, principalKey: string): Promise<SessionRepositoryBundleChunkResult> {
    const transfer = this.transfers.get(transferId)
    if (!transfer || transfer.principalKey !== principalKey) throw new Error('Session bundle transfer is unavailable.')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= transfer.size) throw new Error('Invalid session bundle offset.')
    this.touch(transferId, transfer)
    const file = await open(transfer.path, 'r')
    let result: SessionRepositoryBundleChunkResult
    try {
      const bytes = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, transfer.size - offset))
      for (let read = 0; read < bytes.length;) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, offset + read)
        if (bytesRead === 0) throw new Error('Session bundle ended before its declared size.')
        read += bytesRead
      }
      result = { data: bytes.toString('base64'), done: offset + bytes.length === transfer.size }
    } finally {
      await file.close()
    }
    if (result.done) await this.remove(transferId)
    return result
  }

  /**
   * A stream of the file from byte `start`, when `secret` is the download secret of the
   * transfer. An unknown transfer and a wrong secret get the same answer. The transfer
   * ends when a stream reads the last byte of the file.
   */
  download(transferId: string, secret: string, start: number): SessionBundleDownload {
    const transfer = this.transfers.get(transferId)
    if (!transfer || !timingSafeEqual(hashSecret(secret), transfer.secretHash)) return { kind: 'refused' }
    if (!Number.isSafeInteger(start) || start < 0 || start >= transfer.size) return { kind: 'bad-range', size: transfer.size }
    this.touch(transferId, transfer)
    const stream = createReadStream(transfer.path, { start })
    let readToEnd = false
    stream.on('data', () => this.touch(transferId, transfer))
    stream.on('end', () => { readToEnd = true })
    // After 'close' the file is not open, so the folder can go on every platform.
    stream.on('close', () => { if (readToEnd) void this.remove(transferId) })
    return { kind: 'stream', size: transfer.size, start, stream }
  }

  /** Each read starts the idle time again. */
  private touch(transferId: string, transfer: Transfer): void {
    if (this.transfers.get(transferId) !== transfer) return
    clearTimeout(transfer.timer)
    transfer.timer = setTimeout(() => { void this.remove(transferId) }, IDLE_MS)
    transfer.timer.unref()
  }

  private async remove(transferId: string): Promise<void> {
    const transfer = this.transfers.get(transferId)
    if (!transfer) return
    this.transfers.delete(transferId)
    clearTimeout(transfer.timer)
    await rm(transfer.folder, { recursive: true, force: true })
  }

  async stop(): Promise<void> {
    await Promise.all([...this.transfers.keys()].map((id) => this.remove(id)))
  }
}
