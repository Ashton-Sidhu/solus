import type { Automation } from '@solus/contracts/types'
import type { PullRequest } from '@solus/contracts/providers'
import type { WorkListing } from '../../../../contexts/works/works.store.svelte'
import { folderLabel, triggerSummary } from '../../../automations/lib/automation-format'
import { buildWorkspaceItems, type WorkReviewLookup, type WorkspaceItem, type WorkspaceProjects } from '../../../workspace/lib/workspace-items'
import type { PickerRecord } from './picker-records'
import type { PickerEntry } from './picker-rows'

/**
 * What a record's row and preview say, and the records read from their
 * stores. Apart from `picker-records.ts`, the model, which imports no page's
 * helpers.
 */

const WORK_KIND_LABELS = { doc: 'Doc', slides: 'Slides', artifact: 'Artifact', app: 'App' } satisfies Record<WorkspaceItem['glyph'], string>

/** What a work is, in one word. */
export function workKindLabel(item: WorkspaceItem): string {
  return WORK_KIND_LABELS[item.glyph]
}

/** A row's second line while no passage takes its place: where the record
 *  lives and what it is. */
export function recordDetail(record: PickerRecord): string {
  switch (record.type) {
    case 'work': return `${workKindLabel(record.item)} · ${record.item.projectLabel}`
    case 'automation': {
      const { automation } = record
      const schedule = automation.enabled ? triggerSummary(automation.trigger) : 'Paused'
      return `${schedule} · ${folderLabel(automation.action.cwd)}`
    }
    case 'pullRequest': {
      const { pullRequest, projectLabel } = record.found
      const state = pullRequestStateLabel(pullRequest)
      return `#${pullRequest.number}${state === 'Open' ? '' : ` · ${state}`} · ${projectLabel} · ${pullRequest.author}`
    }
    case 'project': return record.project.projectKey
    case 'action': return ''
  }
}

/** How much of a record's body the preview renders: a preview is the start of
 *  a page, and a long document must not cost a parse on each arrow key. */
const PREVIEW_BODY_MAX = 6000

/** The start of `text`, cut at the end of a line. */
export function previewBody(text: string): string {
  if (text.length <= PREVIEW_BODY_MAX) return text
  const cut = text.slice(0, PREVIEW_BODY_MAX)
  const lineEnd = cut.lastIndexOf('\n')
  return `${lineEnd > PREVIEW_BODY_MAX / 2 ? cut.slice(0, lineEnd) : cut}\n\n…`
}

/** The start of a work's document for the preview. A document often opens
 *  with its own title as a heading. The preview already shows the title above
 *  the body, so that heading is left out. */
export function workPreviewBody(title: string, content: string): string {
  const heading = /^\s*#\s+(.+?)\s*(?:\n|$)/.exec(content)
  const repeatsTitle = heading?.[1]?.trim().toLowerCase() === title.trim().toLowerCase()
  return previewBody(repeatsTitle && heading ? content.slice(heading[0].length) : content)
}

/** A pull request's state as one word, when it is not simply open. */
export function pullRequestStateLabel(pullRequest: Pick<PullRequest, 'state' | 'draft'>): string {
  if (pullRequest.state === 'merged') return 'Merged'
  if (pullRequest.state === 'closed') return 'Closed'
  return pullRequest.draft ? 'Draft' : 'Open'
}

/** What ⏎ does to a record, as the button and the key hint say it. */
export function recordOpenLabel(record: PickerRecord): string {
  if (record.type === 'project') return 'New session'
  return record.type === 'action' ? 'Run' : 'Open'
}

/** What ⏎ does to the row the cursor is on. */
export function entryOpenLabel(entry: PickerEntry): string {
  if (entry.kind === 'record') return recordOpenLabel(entry.record)
  return entry.kind === 'task' ? 'Open task' : 'Resume'
}

/**
 * Whether the preview of a row has an action bar. A bar is for a row with more
 * than one thing to do: a task and its session have a status to set, and a
 * pull request opens here or in the browser. A row with one action has no
 * bar: ⏎ is that action, and the key hints say so.
 */
export function hasActionBar(entry: PickerEntry | null): boolean {
  if (!entry) return false
  if (entry.kind === 'record') return entry.record.type === 'pullRequest'
  return entry.kind !== 'conversation'
}

/** The works of the scope as records: every work with no scope, else the
 *  works of the scoped project. */
export function workRecords(
  works: WorkListing[],
  projects: WorkspaceProjects,
  reviews: WorkReviewLookup,
  scopeProjectKey: string | null,
): PickerRecord[] {
  return buildWorkspaceItems(works, projects, reviews)
    .filter((item) => !scopeProjectKey || item.projectKey === scopeProjectKey)
    .map((item) => ({ type: 'work', item }))
}

/** The automations of the scope as records, by the project each runs in. */
export function automationRecords(
  automations: readonly Automation[],
  projectKeyOf: (automation: Automation) => string,
  scopeProjectKey: string | null,
): PickerRecord[] {
  return automations
    .filter((automation) => !scopeProjectKey || projectKeyOf(automation) === scopeProjectKey)
    .map((automation) => ({ type: 'automation', automation }))
}
