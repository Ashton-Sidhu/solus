import { z } from 'zod'
import type { PrStack, PrStackMembership, RepoRef } from '@solus/contracts/providers'
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
  head: z.object({ ref: z.string() }),
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
    layers: raw.pull_requests.map((pr) => ({
      number: pr.number,
      title: pr.title ?? '',
      headRef: pr.head.ref,
      state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
      draft: pr.draft ?? false,
    })),
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
