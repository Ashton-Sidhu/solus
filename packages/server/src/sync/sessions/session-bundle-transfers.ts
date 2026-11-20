import { randomUUID } from 'node:crypto'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionRepositoryBundleChunkResult, SessionRepositoryBundleResult } from '@solus/contracts/rpc'
import type { SessionRepositories } from './session-repository'

const CHUNK_BYTES = 1024 * 1024
const IDLE_MS = 10 * 60_000

interface Transfer { sessionId: string; path: string; folder: string; size: number; principalKey: string; timer: ReturnType<typeof setTimeout> }

/** Short-lived files for a binary repository transfer over bounded RPC calls. */
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
      const timer = setTimeout(() => { void this.remove(transferId) }, IDLE_MS)
      timer.unref()
      this.transfers.set(transferId, { sessionId, path, folder, size, principalKey, timer })
      return { state: 'ready', transferId, size, head: result.head }
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
    clearTimeout(transfer.timer)
    transfer.timer = setTimeout(() => { void this.remove(transferId) }, IDLE_MS)
    transfer.timer.unref()
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
