import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { PrReviewDraftScope, ReviewState } from '@solus/contracts/review'
import { ownerKeyOf, type Actor } from '../admission/actor'
import { organizationForNew } from '../admission/principal'
import { dataDir } from '../platform/paths'
import { artifactPath, readJson, writeJsonAtomic } from './review-store'

const STATE_SUBDIR = 'review-state'

/** Read the queued review drafts for a branch. Returns an empty store (never
 *  null) so the renderer always has a well-formed object to bind to. */
export async function readReviewState(repoRoot: string, key: string): Promise<ReviewState> {
  if (/[\\/]/.test(key)) throw new Error('Invalid review state key.')
  return (await readJson<ReviewState>(artifactPath(repoRoot, STATE_SUBDIR, key))) ?? { version: 1, key, drafts: [] }
}

/** Overwrite the review-draft store in place (atomic tmp + rename). */
export function writeReviewState(repoRoot: string, state: ReviewState): Promise<boolean> {
  if (/[\\/]/.test(state.key)) throw new Error('Invalid review state key.')
  return writeJsonAtomic(artifactPath(repoRoot, STATE_SUBDIR, state.key), state, `review-state ${state.key}`)
}

const scopeSchema = z.object({
  host: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  headSha: z.string().min(1),
  baseSha: z.string().min(1),
})
const stateSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  summary: z.string().optional(),
  drafts: z.array(z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    line: z.number().int().positive(),
    side: z.enum(['old', 'new']),
    body: z.string(),
    createdAt: z.number(),
  })),
})

/** PR drafts belong to the requester and the remote comparison, even when the
 * host has no checkout. Legacy branch drafts have no recorded revision. */
function prReviewStatePath(actor: Actor, scope: PrReviewDraftScope): string {
  const ownerKey = ownerKeyOf(actor)
  if (!ownerKey) throw new Error('Review drafts require a user.')
  const { host, owner, repo, number, headSha, baseSha } = scopeSchema.parse(scope)
  const key = JSON.stringify([
    organizationForNew(actor.principal), ownerKey,
    host.toLowerCase(), owner.toLowerCase(), repo.toLowerCase(), number, headSha, baseSha,
  ])
  return join(dataDir(), 'pr-review-state', `${createHash('sha256').update(key).digest('hex')}.json`)
}

const pendingWrites = new Map<string, Promise<boolean>>()

export async function readPrReviewState(actor: Actor, scope: PrReviewDraftScope, key: string): Promise<ReviewState> {
  const path = prReviewStatePath(actor, scope)
  await pendingWrites.get(path)
  const state = stateSchema.safeParse(await readJson(path))
  return state.success
    ? { ...state.data, key, summary: state.data.summary ?? '' }
    : { version: 1, key, drafts: [], summary: '' }
}

export async function writePrReviewState(actor: Actor, scope: PrReviewDraftScope, state: ReviewState): Promise<boolean> {
  const path = prReviewStatePath(actor, scope)
  const validated = stateSchema.parse(state)
  const previous = pendingWrites.get(path) ?? Promise.resolve()
  const next = previous.then(() => writeJsonAtomic(path, validated, 'pull request review state'))
  pendingWrites.set(path, next)
  try {
    return await next
  } finally {
    if (pendingWrites.get(path) === next) pendingWrites.delete(path)
  }
}
