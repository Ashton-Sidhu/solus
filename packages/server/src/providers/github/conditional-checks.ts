import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import type { RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from './octokit'

/** A held summary is used again for at most this long. No REST answer says
 *  which checks are required, so the GraphQL read runs again this often. */
const HELD_MS = 5 * 60_000
/** Summaries held per account; the oldest goes first. */
const MAX_HELD = 1_000

/** What REST says about the checks of a pull request: its head, its check
 *  runs, and its commit statuses. */
interface Validator {
  text: string
  merged: boolean
}

interface HeldChecks {
  validator: string
  summary: PrChecksSummary
  readAt: number
  /** A merged pull request's checks do not change again. */
  merged: boolean
}

/**
 * Check runs as a conditional read (docs/plans/pr-sync.md §11), as T3 Code
 * does in `gitHubConditionalChecks.ts`.
 *
 * The GraphQL check read costs points on each poll. Before it, three REST
 * reads ask whether anything moved: `pulls/{n}` for the head, then
 * `commits/{sha}/check-runs` and `commits/{sha}/status`. These go through the
 * ETag layer (conditional-reads.ts), and GitHub does not count a 304 against
 * the quota. When the answers are the same as at the last GraphQL read, and
 * that read is younger than `HELD_MS`, its summary is used again. The GraphQL
 * read runs only for the pull requests that moved.
 */
export class ConditionalChecks {
  private readonly held = new WeakMap<GitHubClient, Map<string, HeldChecks>>()

  constructor(private readonly now: () => number = Date.now) {}

  async read(
    client: GitHubClient,
    repo: RepoRef,
    numbers: number[],
    readMoved: (numbers: number[]) => Promise<NumberedPrChecksSummary[]>,
  ): Promise<NumberedPrChecksSummary[]> {
    const held = this.heldBy(client)
    const answers = new Map<number, PrChecksSummary>()
    const validators = new Map<number, Validator>()
    await Promise.all(numbers.map(async (number) => {
      const key = heldKey(repo, number)
      const last = held.get(key)
      if (last?.merged) {
        answers.set(number, last.summary)
        return
      }
      // A REST failure only means that REST cannot tell; the GraphQL read can.
      const validator = await validatorOf(client, repo, number).catch(() => null)
      if (!validator) return
      validators.set(number, validator)
      if (!last || validator.text !== last.validator) return
      if (!validator.merged && this.now() - last.readAt >= HELD_MS) return
      last.merged = validator.merged
      // Most recently used goes last.
      held.delete(key)
      held.set(key, last)
      answers.set(number, last.summary)
    }))

    const moved = numbers.filter((number) => !answers.has(number))
    if (moved.length) {
      const readAt = this.now()
      for (const { number, summary } of await readMoved(moved)) {
        answers.set(number, summary)
        const key = heldKey(repo, number)
        held.delete(key)
        const validator = validators.get(number)
        if (!validator) continue
        held.set(key, { validator: validator.text, summary, readAt, merged: validator.merged })
        const oldest = held.keys().next()
        if (held.size > MAX_HELD && !oldest.done) held.delete(oldest.value)
      }
    }
    return numbers.flatMap((number) => {
      const summary = answers.get(number)
      return summary ? [{ number, summary }] : []
    })
  }

  private heldBy(client: GitHubClient): Map<string, HeldChecks> {
    let held = this.held.get(client)
    if (!held) {
      held = new Map()
      this.held.set(client, held)
    }
    return held
  }
}

async function validatorOf(client: GitHubClient, repo: RepoRef, number: number): Promise<Validator> {
  const { owner, repo: name } = repo
  const { data: pull } = await client.rest.pulls.get({ owner, repo: name, pull_number: number })
  const ref = pull.head.sha
  const [{ data: runs }, { data: status }] = await Promise.all([
    client.rest.checks.listForRef({ owner, repo: name, ref, per_page: 100 }),
    client.rest.repos.getCombinedStatusForRef({ owner, repo: name, ref, per_page: 100 }),
  ])
  const checkRuns = runs.check_runs.map((run) => `${run.id}:${run.status}:${run.conclusion ?? ''}`).sort()
  const statuses = status.statuses.map((entry) => `${entry.context}:${entry.state}:${entry.updated_at}`).sort()
  return {
    text: [ref, runs.total_count, ...checkRuns, '|', ...statuses].join(' '),
    merged: pull.merged_at !== null,
  }
}

function heldKey(repo: RepoRef, number: number): string {
  return `${repo.host}/${repo.owner}/${repo.repo}#${number}`.toLowerCase()
}
