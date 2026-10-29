import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { WorkTransfer } from '@solus/contracts/work-transfer'
import type { WorkRevisionSummary } from '@solus/contracts/types'
import { contentHash, diskBytes, git, type GitRemote } from './process'

interface StoredRevision extends WorkRevisionSummary { commit: string }
export interface WorkManifest {
  /** Empty content preserves the contract's field order; the body is a separate blob. */
  work: WorkTransfer['work']
  previousRevisionId: number | null
  annotations: WorkTransfer['annotations']
  fingerprint: string
  revisions: StoredRevision[]
}
interface JournalRow { fingerprint: string; status: 'pending' | 'complete'; commit: string | null; payload: string | null }
export interface WorkReceipt { commit: string; scratchBytes: number; elapsedMs: number }

function extension(type: WorkTransfer['work']['type']): string {
  return type === 'doc' ? 'md' : type === 'artifact' ? 'html' : 'json'
}

/** A proof journal, separate from Solus's product database. Pending payloads survive restart. */
export class WorkJournal {
  private readonly db: Database
  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS operations (fingerprint TEXT PRIMARY KEY, status TEXT NOT NULL, commit_id TEXT, payload TEXT)')
  }
  pending(transfer: WorkTransfer): void {
    this.db.query('INSERT OR IGNORE INTO operations VALUES (?, ?, NULL, ?)').run(transfer.fingerprint, 'pending', JSON.stringify(transfer))
  }
  complete(fingerprint: string, commit: string): void {
    this.db.query('UPDATE operations SET status = ?, commit_id = ?, payload = NULL WHERE fingerprint = ?').run('complete', commit, fingerprint)
  }
  read(fingerprint: string): JournalRow | null {
    return this.db.query<JournalRow, [string]>('SELECT fingerprint, status, commit_id AS "commit", payload FROM operations WHERE fingerprint = ?').get(fingerprint)
  }
  close(): void { this.db.close() }
}

function verifyBodies(transfer: WorkTransfer): void {
  const { organizationId: _organizationId, ...work } = transfer.work
  const fingerprint = contentHash(JSON.stringify({ work, previousRevisionId: transfer.previousRevisionId, revisions: transfer.revisions, annotations: transfer.annotations }))
  if (transfer.fingerprint !== fingerprint) throw new Error('Transfer fingerprint mismatch')
  if (contentHash(transfer.work.content) !== transfer.work.contentHash) throw new Error('Current body hash mismatch')
  let previous = 0
  for (const revision of transfer.revisions) {
    if (revision.workId !== transfer.work.id || revision.revisionId <= previous) throw new Error('Invalid revision identity or order')
    if (contentHash(revision.content) !== revision.contentHash) throw new Error('Revision body hash mismatch')
    previous = revision.revisionId
  }
  if (transfer.previousRevisionId !== null && !transfer.revisions.some(revision => revision.revisionId === transfer.previousRevisionId)) throw new Error('Previous revision is missing')
}

/** Experimental Git storage only. Product publication is not changed by this proof. */
export class WorkGitStore {
  constructor(readonly remote: GitRemote) {}

  private async scratch<T>(run: (path: string) => Promise<T>): Promise<T> {
    const path = await mkdtemp(join(tmpdir(), 'solus-artifacts-work-'))
    try {
      await git(path, ['clone', '--bare', '--filter=blob:none', '--no-local', this.remote.url, 'repo'], { remote: this.remote })
      return await run(join(path, 'repo'))
    } finally { await rm(path, { recursive: true, force: true }) }
  }

  private async head(path: string): Promise<string | null> {
    const result = await git(path, ['rev-parse', '--verify', 'refs/heads/main'], { allowFailure: true })
    return result.code === 0 ? result.stdout.trim() : null
  }

  private async manifest(path: string, commit: string): Promise<WorkManifest> {
    // SAFETY: this proof owns the repo and is its only writer. readAt rechecks the transfer fingerprint, every body hash, and immutable revision metadata.
    return JSON.parse((await git(path, ['show', `${commit}:manifest.json`], { remote: this.remote })).stdout) as WorkManifest
  }

  private async commit(path: string, files: Array<{ path: string; content: string }>, parent: string | null, message: string, date: string): Promise<string> {
    const entries: string[] = []
    for (const file of files) {
      const blob = (await git(path, ['hash-object', '-w', '--stdin'], { input: file.content })).stdout.trim()
      entries.push(`100644 blob ${blob}\t${file.path}\n`)
    }
    const tree = (await git(path, ['mktree'], { input: entries.sort().join('') })).stdout.trim()
    return (await git(path, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], {
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })).stdout.trim()
  }

  async publish(transfer: WorkTransfer, journal: WorkJournal, options: {
    expectedContentVersion?: number
    beforePush?: () => Promise<void>
    afterPush?: () => Promise<void>
  } = {}): Promise<WorkReceipt> {
    verifyBodies(transfer)
    journal.pending(transfer)
    const started = performance.now()
    return this.scratch(async (path) => {
      const oldHead = await this.head(path)
      const old = oldHead ? await this.manifest(path, oldHead) : null
      if (old?.fingerprint === transfer.fingerprint && oldHead) {
        const recovered = await this.readAt(path, oldHead, old)
        if (!isDeepStrictEqual(recovered, JSON.parse(JSON.stringify(transfer)))) throw new Error('Retry does not match stored transfer')
        journal.complete(transfer.fingerprint, oldHead)
        return { commit: oldHead, scratchBytes: await diskBytes(path), elapsedMs: performance.now() - started }
      }
      if (old && (options.expectedContentVersion === undefined || old.work.contentVersion !== options.expectedContentVersion)) throw new Error('Stale cloud content version')
      if (old && old.work.id !== transfer.work.id) throw new Error('A repo cannot hold another work')
      const revisions: StoredRevision[] = old ? [...old.revisions] : []
      let parent = oldHead
      for (const revision of transfer.revisions) {
        const existing = revisions.find(item => item.revisionId === revision.revisionId)
        const { content, ...summary } = revision
        if (existing) {
          const { commit: _commit, ...storedSummary } = existing
          if (JSON.stringify(storedSummary) !== JSON.stringify(summary)) throw new Error('An immutable revision changed')
          continue
        }
        parent = await this.commit(path, [
          { path: `content.${extension(transfer.work.type)}`, content },
          { path: 'revision.json', content: JSON.stringify(summary) },
        ], parent, `revision ${revision.revisionId}: ${revision.reason}`, revision.capturedAt)
        revisions.push({ ...summary, commit: parent })
      }
      if (revisions.length !== transfer.revisions.length) throw new Error('History cannot lose revisions')
      const content = transfer.work.content
      const work = { ...transfer.work, content: '' }
      const manifest: WorkManifest = { work, previousRevisionId: transfer.previousRevisionId, annotations: transfer.annotations, fingerprint: transfer.fingerprint, revisions }
      const commit = await this.commit(path, [
        { path: `content.${extension(work.type)}`, content },
        { path: 'manifest.json', content: JSON.stringify(manifest) },
      ], parent, `snapshot ${transfer.fingerprint}`, work.updatedAt)
      await git(path, ['update-ref', 'refs/heads/main', commit])
      await options.beforePush?.()
      await git(path, ['push', `--force-with-lease=refs/heads/main:${oldHead ?? ''}`, 'origin', 'refs/heads/main:refs/heads/main'], { remote: this.remote })
      await options.afterPush?.()
      journal.complete(transfer.fingerprint, commit)
      return { commit, scratchBytes: await diskBytes(path), elapsedMs: performance.now() - started }
    })
  }

  private async readAt(path: string, commit: string, manifest: WorkManifest): Promise<WorkTransfer> {
    const bodyPath = `content.${extension(manifest.work.type)}`
    const content = (await git(path, ['show', `${commit}:${bodyPath}`], { remote: this.remote })).stdout
    const revisions: WorkTransfer['revisions'] = []
    for (const revision of manifest.revisions) {
      const { commit: revisionCommit, ...summary } = revision
      const body = (await git(path, ['show', `${revisionCommit}:${bodyPath}`], { remote: this.remote })).stdout
      const immutableSummary = (await git(path, ['show', `${revisionCommit}:revision.json`], { remote: this.remote })).stdout
      if (immutableSummary !== JSON.stringify(summary)) throw new Error('Revision metadata differs from its immutable commit')
      revisions.push({ ...summary, content: body })
    }
    const transfer: WorkTransfer = { work: { ...manifest.work, content }, previousRevisionId: manifest.previousRevisionId, revisions, annotations: manifest.annotations, fingerprint: manifest.fingerprint }
    verifyBodies(transfer)
    return transfer
  }

  async read(): Promise<WorkTransfer> {
    return this.scratch(async (path) => {
      const head = await this.head(path)
      if (!head) throw new Error('Work has not been published')
      return this.readAt(path, head, await this.manifest(path, head))
    })
  }
}
