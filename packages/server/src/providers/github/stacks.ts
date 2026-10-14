import { z } from 'zod'
import type { PrStack, PrStackLayer, PrStackMembership, PrStackMergeRequest, RepoRef } from '@solus/contracts/providers'
import { isGithubNotFound, type GitHubClient } from './octokit'

/**
 * GitHub stacked pull requests: a chain of pull requests, each based on the
 * head of the one below it, that GitHub lands in order. The stacks API is a
 * public preview, so everything read here is optional and parsed leniently;
 * a shape it does not recognise reads as "no stack", never as a failure.
 */

/** The GraphQL fields that place one pull request in its stack. Asked for
 *  beside every row the list reads, so membership costs no request of its own. */
export const STACK_MEMBERSHIP_FIELDS = 'stack { number size baseRefName } stackEntry { position }'

export interface GqlStackMembership {
  stack?: { number: number; size: number; baseRefName: string } | null
  stackEntry?: { position: number } | null
}

/** Null when GitHub says the pull request is in no stack. */
export function stackMembershipOf(row: GqlStackMembership): PrStackMembership | null {
  if (!row.stack || !row.stackEntry) return null
  return {
    number: row.stack.number,
    position: row.stackEntry.position,
    size: row.stack.size,
    base: row.stack.baseRefName,
  }
}

const restStackPullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string().optional(),
  draft: z.boolean().optional(),
  state: z.string().nullish(),
  merged_at: z.string().nullish(),
  head: z.object({ ref: z.string(), sha: z.string().optional() }),
})

/** `base` is the ref object the preview sends today, or the bare branch name it started as. */
const restStackSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  html_url: z.string().nullish(),
  base: z.union([z.string(), z.object({ ref: z.string() }).transform((base) => base.ref)]),
  pull_requests: z.array(restStackPullRequestSchema),
})

function toPrStack(raw: z.infer<typeof restStackSchema>): PrStack {
  return {
    number: raw.number,
    url: raw.html_url || raw.url,
    base: raw.base,
    layers: raw.pull_requests.map((pr) => {
      const layer: PrStackLayer = {
        number: pr.number,
        title: pr.title ?? '',
        headRef: pr.head.ref,
        state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        draft: pr.draft ?? false,
      }
      if (pr.head.sha) layer.headSha = pr.head.sha
      return layer
    }),
  }
}

/**
 * The stack `number` is in, bottom to top, or null when it is in none.
 *
 * `?pull_request=` answers an array because a listing is the endpoint's shape,
 * but a pull request is in at most one stack. The listing can leave titles
 * off its layers, so the stack is read once more by its own number.
 *
 * A 404 is GitHub saying the preview is not on for this repository. Callers
 * must check the repository is visible before believing that, since GitHub
 * also answers 404 for a repository the credential cannot see.
 */
export async function readPullRequestStack(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
): Promise<PrStack | null> {
  const listed = await client.rest.request('GET /repos/{owner}/{repo}/stacks', {
    owner: repo.owner,
    repo: repo.repo,
    pull_request: number,
  })
  const found = z.array(restStackSchema).safeParse(listed.data)
  const stack = found.success ? found.data[0] : undefined
  if (!stack) return null
  const full = await client.rest.request('GET /repos/{owner}/{repo}/stacks/{stack_number}', {
    owner: repo.owner,
    repo: repo.repo,
    stack_number: stack.number,
  }).catch((error) => {
    if (isGithubNotFound(error)) return null
    throw error
  })
  const detailed = full ? restStackSchema.safeParse(full.data) : null
  return toPrStack(detailed?.success ? detailed.data : stack)
}

/**
 * A stack merge that Solus refused before it asked GitHub, or that GitHub
 * answered with a clear status. Its message is for the person as it is; any
 * other failure is GitHub's own and gets the provider's refusal wording.
 */
export class GithubStackMergeRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubStackMergeRefusal'
  }
}

const STACK_CHANGED = 'The stack changed. Refresh it before you merge.'

const mergeAsyncSchema = z.object({
  status: z.enum(['pending', 'merged', 'enqueued', 'failed']),
  details: z.object({ uuid: z.string().optional(), message: z.string().optional() }).optional(),
})

/** How long a stack merge waits for GitHub to finish, and how it waits. Tests replace it. */
export interface StackMergeClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const SYSTEM_CLOCK: StackMergeClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** GitHub merges a stack in the background. A merge that is not done after this is reported as still running. */
const STACK_MERGE_DEADLINE_MS = 5 * 60_000

export interface GithubStackMerge {
  status: 'merged' | 'queued'
  /** The open layers the merge landed, bottom to top. */
  layers: number[]
}

/**
 * Merge `request.number` and every open layer below it with GitHub's stack
 * merge (`PUT …/pulls/{number}/merge-async`). Adapted from T3 Code (MIT,
 * pingdotgg/t3code@e2e95a39d,
 * packages/source-control-github/src/server/githubStackActions.ts).
 *
 * The stack is read again first. Every open layer up to the target must have
 * the head the viewer saw, so a push to any layer since then stops the merge
 * before GitHub is asked. The target's head also goes to GitHub as `sha`, so
 * GitHub itself refuses a target that moved after this check.
 */
export async function mergeGithubPullRequestStack(
  client: GitHubClient,
  repo: RepoRef,
  request: PrStackMergeRequest,
  clock: StackMergeClock = SYSTEM_CLOCK,
): Promise<GithubStackMerge> {
  const open = layersToMerge(await readPullRequestStack(client, repo, request.number), request)
  const target = open[open.length - 1]
  const started = await client.rest.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async', {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: request.number,
    merge_method: request.method,
    merge_action: 'default',
    sha: target.headSha,
  })
  const result = await awaitStackMerge(client, repo, request.number, parseMergeAsync(started.data), clock)
  return { status: result === 'enqueued' ? 'queued' : 'merged', layers: open.map((layer) => layer.number) }
}

/**
 * The open layers from the bottom of the stack up to the target, after a
 * check that each is the layer the viewer saw. The target is the last one.
 */
function layersToMerge(stack: PrStack | null, request: PrStackMergeRequest): PrStackLayer[] {
  const targetIndex = stack?.layers.findIndex((layer) => layer.number === request.number) ?? -1
  const target = stack?.layers[targetIndex]
  if (!stack || stack.number !== request.stackNumber || !target) throw new GithubStackMergeRefusal(STACK_CHANGED)
  if (target.state !== 'open') throw new GithubStackMergeRefusal('Only an open pull request in a stack can be merged.')
  const open = stack.layers.slice(0, targetIndex + 1).filter((layer) => layer.state !== 'merged')
  if (open.some((layer) => layer.state === 'closed')) {
    throw new GithubStackMergeRefusal('A closed pull request is below this one in the stack. Reopen it or remove it from the stack, then merge.')
  }
  const expected = new Map(request.expectedHeads.map((head) => [head.number, head.headSha]))
  const unchanged = expected.size === request.expectedHeads.length
    && expected.size === open.length
    && open.every((layer) => !!layer.headSha && expected.get(layer.number) === layer.headSha)
  if (!unchanged) throw new GithubStackMergeRefusal(STACK_CHANGED)
  if (open.some((layer) => layer.draft)) {
    throw new GithubStackMergeRefusal('A draft pull request is in the part of the stack to merge. Mark it ready for review, then merge.')
  }
  return open
}

/** Follow a merge GitHub runs in the background until it lands or is queued. */
async function awaitStackMerge(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  started: z.infer<typeof mergeAsyncSchema>,
  clock: StackMergeClock,
): Promise<'merged' | 'enqueued'> {
  let result = started
  const deadline = clock.now() + STACK_MERGE_DEADLINE_MS
  for (let attempt = 0; result.status === 'pending' && clock.now() < deadline; attempt++) {
    const uuid = result.details?.uuid
    if (!uuid) throw new GithubStackMergeRefusal('GitHub did not say how to follow the stack merge. Check its status on GitHub.')
    await clock.sleep(Math.min(1_000 * 2 ** attempt, 10_000))
    const poll = await client.rest.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}', {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
      uuid,
    })
    result = parseMergeAsync(poll.data)
  }
  if (result.status === 'pending') {
    throw new GithubStackMergeRefusal('The stack merge still runs on GitHub. Check its status there before you try again.')
  }
  if (result.status === 'failed') {
    const reason = result.details?.message?.trim().replace(/\.$/, '')
    throw new GithubStackMergeRefusal(`GitHub refused the stack merge${reason ? `: ${reason}` : ''}. Check the branch rules and merge requirements of the stack.`)
  }
  return result.status
}

function parseMergeAsync<Data>(data: Data): z.infer<typeof mergeAsyncSchema> {
  const parsed = mergeAsyncSchema.safeParse(data)
  if (!parsed.success) throw new GithubStackMergeRefusal('GitHub sent a stack merge answer that Solus cannot read. Check the merge on GitHub.')
  return parsed.data
}
