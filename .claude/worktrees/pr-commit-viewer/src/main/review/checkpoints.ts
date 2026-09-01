import { artifactPath, readJson, writeJsonAtomic } from './review-store'
import type { ReviewCheckpoint } from '../../shared/git-types'

type CheckpointFile = Record<string, ReviewCheckpoint>

const pendingWrites = new Map<string, Promise<boolean>>()

function checkpointsPath(repoRoot: string): string {
  return artifactPath(repoRoot, 'review', 'checkpoints')
}

function isCheckpoint(value: unknown): value is ReviewCheckpoint {
  if (!value || typeof value !== 'object') return false
  const checkpoint = value as Partial<ReviewCheckpoint>
  return Number.isInteger(checkpoint.prNumber)
    && typeof checkpoint.headSha === 'string'
    && typeof checkpoint.base === 'string'
    && typeof checkpoint.reviewedAt === 'string'
}

export async function readReviewCheckpoint(repoRoot: string, prNumber: number): Promise<ReviewCheckpoint | null> {
  const file = await readJson<CheckpointFile>(checkpointsPath(repoRoot))
  const checkpoint = file?.[String(prNumber)]
  return isCheckpoint(checkpoint) ? checkpoint : null
}

export async function writeReviewCheckpoint(repoRoot: string, checkpoint: ReviewCheckpoint): Promise<boolean> {
  const path = checkpointsPath(repoRoot)
  const previous = pendingWrites.get(path) ?? Promise.resolve(true)
  // Serialize the read-modify-write per repo so simultaneous reviews of two PRs
  // cannot overwrite each other's latest checkpoint.
  const pending = previous.then(async () => {
    const file = await readJson<CheckpointFile>(path) ?? {}
    file[String(checkpoint.prNumber)] = checkpoint
    return writeJsonAtomic(path, file, 'review checkpoints')
  })
  pendingWrites.set(path, pending)
  try {
    return await pending
  } finally {
    if (pendingWrites.get(path) === pending) pendingWrites.delete(path)
  }
}
