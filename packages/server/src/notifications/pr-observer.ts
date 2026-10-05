import type { NotificationPr } from '@solus/contracts/notification-hub'
import type { PullRequest, RepoRef } from '@solus/contracts/providers'
import { z } from 'zod'
import { getDb } from '../db'
import { getDatabase } from '../db/database'
import { recordNotification } from '../data/notifications/store'
import { hostCategory, LOCAL_ORGANIZATION_ID } from '../host/host-category'
import { hostUserKey } from '../host/host-user'
import { isOrganizationAttached } from '../host/organization-attachment'

export interface PrObserverDependencies {
  /**
   * The person the code-host credential belongs to, by user key, or null when no
   * single person owns it (a shared, attached, or managed machine). Then nothing
   * is recorded: a provider login is never matched to a person by name.
   */
  recipient(): string | null
  organizationId(): string
  now?(): number
}

interface Pending {
  review: number[]
  assigned: number[]
}

const pendingSchema = z.object({ review: z.array(z.number()), assigned: z.array(z.number()) })
const observationSchema = z.object({ pending: z.string(), observed_at: z.number() })

/**
 * Pull request assignments and review requests, recorded from the answers an
 * existing authorized refresh already read (plans/015-notifications-hub.md §5):
 * PR sync's needs-review read. Nothing here asks the code host. Polling cannot
 * see a request made and removed between two answers, and nothing is recorded
 * while no refresh runs. The first answer for a repository is a quiet baseline.
 * The baseline is provider observation state, not a notification journal: it
 * recognizes a request that went away and came back as a new one. The caller
 * passes only complete answers; a failed read never reaches here, so an error
 * never reads as a removal.
 */
export class PrObserver {
  constructor(private readonly deps: PrObserverDependencies) {}

  async observe(repo: RepoRef, viewer: string, rows: readonly PullRequest[]): Promise<void> {
    const recipient = this.deps.recipient()
    if (!recipient) return
    const login = viewer.toLowerCase()
    const repoKey = `${repo.host}/${repo.owner}/${repo.repo}`.toLowerCase()
    const byNumber = new Map(rows.map((row) => [row.number, row]))
    const current: Pending = {
      review: rows.filter((row) => row.requestedReviewers?.some((reviewer) => reviewer.login.toLowerCase() === login)).map((row) => row.number).sort((a, b) => a - b),
      assigned: rows.filter((row) => row.assignees?.some((assignee) => assignee.toLowerCase() === login)).map((row) => row.number).sort((a, b) => a - b),
    }
    const authority = `${repo.host.toLowerCase()}:${login}`
    const previousRow = observationSchema.nullish().parse(getDb().prepare(
      'SELECT pending, observed_at FROM notification_pr_observations WHERE authority = ? AND repo = ? AND recipient_key = ?',
    ).get(authority, repoKey, recipient))

    if (previousRow) {
      const previous = pendingSchema.parse(JSON.parse(previousRow.pending))
      const organizationId = this.deps.organizationId()
      // Events are named by the baseline they follow, so an answer recorded but not
      // yet saved as the new baseline records the same events again: none.
      const since = previousRow.observed_at
      await getDatabase().transaction(async (tx) => {
        for (const [field, kind] of [['review', 'pr.review_requested'], ['assigned', 'pr.assigned']] as const) {
          const before = new Set(previous[field])
          for (const number of current[field]) {
            if (before.has(number)) continue
            const row = byNumber.get(number)
            const pr: NotificationPr = { ...repo, number }
            if (row?.url) pr.url = row.url
            await recordNotification(tx, {
              organizationId, eventId: `${kind}:${authority}:${repoKey}#${number}:after:${since}`, recipients: [recipient],
              facts: { kind }, resource: { kind: 'pr', pr }, by: { kind: 'upstream', provider: 'github' },
              summary: { title: (row?.title ?? `#${number}`).slice(0, 300), detail: `${repo.owner}/${repo.repo}#${number}` },
            })
          }
        }
      })
    }
    getDb().prepare(`
      INSERT INTO notification_pr_observations (authority, repo, recipient_key, pending, observed_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (authority, repo, recipient_key) DO UPDATE SET pending = excluded.pending, observed_at = excluded.observed_at
    `).run(authority, repoKey, recipient, JSON.stringify(current), this.deps.now?.() ?? Date.now())
  }
}

/**
 * The observer of a personal host, whose code-host credential belongs to the
 * host's user. Any other machine has no single owner of that credential.
 */
export function hostPrObserver(): PrObserver {
  return new PrObserver({
    recipient: () => hostCategory() === 'personal' && !isOrganizationAttached() ? hostUserKey() : null,
    organizationId: () => LOCAL_ORGANIZATION_ID,
  })
}
