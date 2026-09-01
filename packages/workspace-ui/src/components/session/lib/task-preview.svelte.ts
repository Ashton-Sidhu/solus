import { GitPullRequest as GitPullRequestIcon } from "@lucide/svelte";
  import type { TaskDetails, TaskLink, TaskSidebarPrLink } from '@solus/contracts/task-types'
import type { LinkedPrLifecycle } from '../../tasks/task-page/lib/task-prs'
import { taskPrRows } from '../../tasks/task-page/lib/task-prs'
import { prStatusBadge } from '../../prs/lib/pr-utils'

/**
 * Detail loading and row shaping for the task picker's preview pane.
 *
 * `task_links` is a local table, so a task's links are our own data — but the
 * *listed* task does not carry them. Only two reads produce them: the sidebar
 * snapshot's `prLinksByTask`, which is one query over every task and therefore
 * already in hand, and a per-task detail read for everything else. That second
 * read is a local DB read for a local task and a provider round trip for an
 * upstream one, so the preview must not fire it on every arrow key.
 *
 * The split follows from that: PRs come from the snapshot and render instantly
 * for every task, while the full Linked set waits for the selection to settle
 * and is asked for once per task. The store owns the cache; the preview reads
 * it back through `detailsFor`.
 */
const SETTLE_MS = 220

export class TaskPreviewDetails {
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly requested = new Set<string>()

  constructor(
    private readonly load: (taskId: string, projectKey?: string) => Promise<TaskDetails | null>,
  ) {}

  /** Ask for this task's detail once the selection has stopped moving. */
  request(taskId: string | null | undefined, projectKey?: string): void {
    this.cancel()
    if (!taskId || this.requested.has(taskId)) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.requested.has(taskId)) return
      this.requested.add(taskId)
      // A failed read leaves the preview without a Linked section, which is the
      // same thing it shows for a task that has no links. Nothing to report.
      void this.load(taskId, projectKey).catch(() => this.requested.delete(taskId))
    }, SETTLE_MS)
  }

  /** Drop a pending request — the picker closed, or the selection moved on. */
  cancel(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

export interface TaskPreviewPrRow {
  key: string
  ref: string
  /** Empty until the detail read lands: the snapshot edge carries a number and
   *  a url, never a title, and the row says nothing rather than inventing one. */
  title: string
  state: LinkedPrLifecycle | null
}

/** The left-rail PR mark: always a pull-request glyph, coloured by lifecycle
 *  when it is known and neutral until then, so a linked PR is never a blank
 *  slot. Draft, merged and closed keep the same status glyphs the PR surfaces
 *  use, so the icon reads the same everywhere. */
export function previewPrGlyph(state: LinkedPrLifecycle | null) {
  const badge = prStatusBadge(state)
  if (badge) return { Icon: badge.Icon, tone: badge.tone }
  return { Icon: GitPullRequestIcon, tone: 'var(--solus-text-tertiary)' }
}

/**
 * The preview's pull requests. The snapshot's newest edge is the seed, so a
 * task names its PR the moment it is selected; the detail read then replaces it
 * with the full list, which is also where titles come from.
 */
export function previewPrRows(
  links: TaskLink[],
  snapshotLink: TaskSidebarPrLink | null,
  lifecycleFor: (number: number) => LinkedPrLifecycle | null,
  titleFor: (number: number) => string | undefined = () => undefined,
): TaskPreviewPrRow[] {
  const rows = taskPrRows(links, lifecycleFor, titleFor)
  if (rows.length) {
    return rows.map((row) => ({ key: row.key, ref: row.ref, title: row.title, state: row.state }))
  }
  if (!snapshotLink) return []
  return [{
    key: `pr:${snapshotLink.number}`,
    ref: `#${snapshotLink.number}`,
    title: titleFor(snapshotLink.number) ?? '',
    state: lifecycleFor(snapshotLink.number),
  }]
}
