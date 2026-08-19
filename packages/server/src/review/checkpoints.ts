import { artifactPath, readJson, writeJsonAtomic } from './review-store'
import type { ReviewCheckpoint } from '@solus/contracts/git-types'
import { z } from 'zod'

const reviewCheckpointSchema = z.object({
  prNumber: z.number().int(),
  headSha: z.string(),
  base: z.string(),
  reviewedAt: z.string(),
})

const checkpointFileSchema = z.record(z.string(), reviewCheckpointSchema)

const pendingWrites = new Map<string, Promise<boolean>>()

function checkpointsPath(repoRoot: string): string {
  return artifactPath(repoRoot, 'review', 'checkpoints')
}

export async function readReviewCheckpoint(repoRoot: string, prNumber: number): Promise<ReviewCheckpoint | null> {
  const parsed = checkpointFileSchema.safeParse(await readJson<unknown>(checkpointsPath(repoRoot)))
  return parsed.success ? parsed.data[String(prNumber)] ?? null : null
}

export async function writeReviewCheckpoint(repoRoot: string, checkpoint: ReviewCheckpoint): Promise<boolean> {
  const path = checkpointsPath(repoRoot)
  const previous = pendingWrites.get(path) ?? Promise.resolve(true)
  // Serialize the read-modify-write per repo so simultaneous reviews of two PRs
  // cannot overwrite each other's latest checkpoint.
  const pending = previous.then(async () => {
    const parsed = checkpointFileSchema.safeParse(await readJson<unknown>(path))
    const file = parsed.success ? parsed.data : {}
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
