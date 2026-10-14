import { z } from 'zod'
import type { PullRequestWatchFingerprint } from '../types'
import { HostBatches, pullRequestByNumber, type RepositoryRows } from './host-batches'

/**
 * The fingerprint of a watched pull request (docs/plans/pr-watch.md §11): one
 * aliased GraphQL query reads up to 25 pull requests, of every repository one
 * account watches, for about one point (host-batches.ts). The selection is
 * T3 Code's, which runs in production (`gitHubPullRequestJson.ts` at `611132c171`).
 */

const EDITS = 'totalCount nodes { lastEditedAt }'
const CHECK_COUNTS = 'checkRunCountsByState { state count } statusContextCountsByState { state count }'

/** The rows are as Octokit hands them over; the decoder checks their shape. */
export const fingerprintRows = new HostBatches<object>({
  operation: 'PrWatchFingerprints',
  // GitHub prices a query by its nodes, not its aliases, up to this many.
  perDocument: 25,
  field: pullRequestByNumber(() => `
        state mergeable headRefOid
        comments(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { ${EDITS} }
        reviews(last: 100) { ${EDITS} }
        reviewThreads { totalCount }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts { ${CHECK_COUNTS} } } } } }`),
})

const editsSchema = z.object({
  totalCount: z.number(),
  nodes: z.array(z.object({ lastEditedAt: z.string().nullable() }).nullable()),
})
const countsSchema = z.array(z.object({ state: z.string(), count: z.number() })).nullable()
const pullRequestSchema = z.object({
  state: z.string(),
  mergeable: z.string().nullable(),
  headRefOid: z.string(),
  comments: editsSchema,
  reviews: editsSchema,
  reviewThreads: z.object({ totalCount: z.number() }),
  commits: z.object({
    nodes: z.array(z.object({
      commit: z.object({
        statusCheckRollup: z.object({
          contexts: z.object({ checkRunCountsByState: countsSchema, statusContextCountsByState: countsSchema }),
        }).nullable(),
      }),
    }).nullable()),
  }),
})

/** The fingerprint of each number GitHub answered; a number it did not
 *  answer, or answered in a shape this does not know, is left out. */
export function decodeWatchFingerprints(rows: RepositoryRows<object>, numbers: number[]): Map<number, PullRequestWatchFingerprint> {
  const aliases = z.object(Object.fromEntries(numbers.map((number) => [`p${number}`, pullRequestSchema.nullable().catch(null)])))
  const repository = aliases.parse(rows)
  const fingerprints = new Map<number, PullRequestWatchFingerprint>()
  for (const number of numbers) {
    const pullRequest = repository[`p${number}`]
    if (!pullRequest) continue
    const contexts = pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts
    fingerprints.set(number, {
      status: [
        pullRequest.state,
        pullRequest.mergeable ?? '',
        pullRequest.headRefOid,
        stateCounts(contexts?.checkRunCountsByState ?? null),
        stateCounts(contexts?.statusContextCountsByState ?? null),
      ].join(' '),
      remarks: [
        pullRequest.comments.totalCount,
        newestEdit(pullRequest.comments),
        pullRequest.reviews.totalCount,
        newestEdit(pullRequest.reviews),
        pullRequest.reviewThreads.totalCount,
      ].join(' '),
    })
  }
  return fingerprints
}

function newestEdit(connection: z.output<typeof editsSchema>): string {
  return connection.nodes.reduce((newest, node) =>
    node?.lastEditedAt && node.lastEditedAt > newest ? node.lastEditedAt : newest, '')
}

function stateCounts(counts: z.output<typeof countsSchema>): string {
  return (counts ?? [])
    .filter(({ count }) => count > 0)
    .map(({ state, count }) => `${state}:${count}`)
    .sort()
    .join(',')
}
