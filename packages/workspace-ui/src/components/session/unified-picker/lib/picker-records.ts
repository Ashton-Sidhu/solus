import type { Automation } from '@solus/contracts/types'
import type { PullRequest } from '@solus/contracts/providers'
import type { SearchQuery } from '@solus/contracts/search-query'
import type { ListProjectOption } from '../../../ui/list-page/list-page'
import type { WorkspaceItem } from '../../../workspace/lib/workspace-items'
import { activityScore, compareRelevance, nameScore, type Relevance } from './picker-relevance'
import type { PickerRecordResultType } from './picker-result-types'
import { matchWindow, type PickerSort } from './picker-search'

/**
 * The records the search lists beside tasks and sessions
 * (docs/plans/unified-search.md, "Search types"): works, pull requests,
 * automations and projects, and the actions at the end of the list. A record
 * is matched on this client by the word rule the tasks and sessions follow, so
 * one query means one thing in every section.
 *
 * This is the model: what a record is and how a query finds it. What its row
 * and preview say, and the reads of the stores, are in `picker-record-view.ts`.
 */

/** A pull request a host listed, with the project it was read through. */
export interface FoundPullRequest {
  pullRequest: PullRequest
  serverId: string
  projectRoot: string
  projectLabel: string
}

/** A command the search offers at the end of its list. */
export interface PickerAction {
  id: string
  label: string
  /** Its shortcut, as the keybinding manifest prints it. */
  hint?: string
  run: () => void
}

export type PickerRecord =
  | { type: 'work'; item: WorkspaceItem }
  | { type: 'automation'; automation: Automation }
  /** `hostMatched`: the code host found it for the query in the box, by words
   *  this client may not hold (its description, its comments). */
  | { type: 'pullRequest'; found: FoundPullRequest; hostMatched: boolean }
  | { type: 'project'; project: ListProjectOption }
  | { type: 'action'; action: PickerAction }

/** A record this relevant to the query, and the passage that says why when
 *  its title does not. */
export interface RankedRecord {
  record: PickerRecord
  relevance: Relevance
  passage?: string
}

/** The order of the record sections under a query that lists every type. */
export const RECORD_SECTION_ORDER: readonly PickerRecordResultType[] = ['works', 'pullRequests', 'automations', 'projects']

/** The type a record is listed under. Null for an action, which has its own section. */
export function recordResultType(record: PickerRecord): PickerRecordResultType | null {
  switch (record.type) {
    case 'work': return 'works'
    case 'automation': return 'automations'
    case 'pullRequest': return 'pullRequests'
    case 'project': return 'projects'
    case 'action': return null
  }
}

/** Row identity: stable while the list is rebuilt on each keystroke. */
export function recordKey(record: PickerRecord): string {
  switch (record.type) {
    case 'work': return `work:${record.item.id}`
    case 'automation': return `automation:${record.automation.id}`
    case 'pullRequest': return `pr:${record.found.serverId}:${record.found.projectRoot}:${record.found.pullRequest.number}`
    case 'project': return `project:${record.project.key}`
    case 'action': return `action:${record.action.id}`
  }
}

export function recordTitle(record: PickerRecord): string {
  switch (record.type) {
    case 'work': return record.item.title
    case 'automation': return record.automation.name || 'Untitled automation'
    case 'pullRequest': return record.found.pullRequest.title
    case 'project': return record.project.label
    case 'action': return record.action.label
  }
}

/** When the record last changed, in epoch milliseconds. Zero for a record with
 *  no date: a project, an action. */
export function recordTimestamp(record: PickerRecord): number {
  switch (record.type) {
    case 'work': return record.item.timestamp
    case 'automation': return Date.parse(record.automation.updatedAt) || 0
    case 'pullRequest': return Date.parse(record.found.pullRequest.updatedAt) || 0
    case 'project':
    case 'action': return 0
  }
}

/** The text of a record that is searched when its title does not hold the words. */
function recordEvidence(record: PickerRecord): string {
  switch (record.type) {
    case 'work': return record.item.snippet
    case 'automation': return record.automation.action.prompt
    case 'pullRequest': return `${record.found.pullRequest.headRef} ${record.found.pullRequest.author}`
    case 'project': return record.project.projectKey
    case 'action': return ''
  }
}

/**
 * Where the query hit a record, or null for no hit. The words in its title
 * are a name hit. A pull request's number, typed whole, is the pull request
 * itself. Words found only in the record's other text are evidence, and the
 * row shows the passage. A pull request the code host found is evidence too:
 * the host read text this client does not hold.
 */
export function matchRecord(record: PickerRecord, search: SearchQuery, now: number): RankedRecord | null {
  const activity = activityScore(recordTimestamp(record), now)
  if (search.isEmpty) return { record, relevance: { tier: 'evidence', score: activity } }
  if (record.type === 'pullRequest' && search.words.length === 1 && search.words[0] === String(record.found.pullRequest.number)) {
    return { record, relevance: { tier: 'id', score: activity } }
  }
  const title = recordTitle(record)
  if (search.matchName(title)) return { record, relevance: { tier: 'name', score: nameScore(title, search) + activity } }
  const evidence = recordEvidence(record)
  if (evidence && search.holdsEveryWord(evidence)) {
    return { record, relevance: { tier: 'evidence', score: activity }, passage: matchWindow(evidence, search) }
  }
  if (record.type === 'pullRequest' && record.hostMatched) return { record, relevance: { tier: 'evidence', score: activity } }
  return null
}

/** Best match first, then newest; or newest alone. A stable sort, so records
 *  with no date keep the order they came in. */
function compareRanked(sort: PickerSort) {
  return (a: RankedRecord, b: RankedRecord): number =>
    (sort === 'relevance' ? compareRelevance(a.relevance, b.relevance) : 0)
    || recordTimestamp(b.record) - recordTimestamp(a.record)
}

/**
 * The records the query and the Updated filter keep, by the type they are
 * listed under, each type in the reader's order. A record with no date is not
 * narrowed by Updated. Actions are not records of a type: see `matchActions`.
 */
export function rankRecords(
  records: readonly PickerRecord[],
  search: SearchQuery,
  sort: PickerSort,
  now: number,
  since: number | undefined,
): Map<PickerRecordResultType, RankedRecord[]> {
  const byType = new Map<PickerRecordResultType, RankedRecord[]>()
  for (const record of records) {
    const type = recordResultType(record)
    if (!type) continue
    const ts = recordTimestamp(record)
    if (since !== undefined && ts && ts < since) continue
    const ranked = matchRecord(record, search, now)
    if (!ranked) continue
    const list = byType.get(type)
    if (list) list.push(ranked)
    else byType.set(type, [ranked])
  }
  for (const list of byType.values()) list.sort(compareRanked(search.isEmpty ? 'recency' : sort))
  return byType
}

/** The actions the list ends with: every action while the box is empty, else
 *  the ones the query names. */
export function matchActions(actions: readonly PickerAction[], search: SearchQuery): PickerAction[] {
  return search.isEmpty ? [...actions] : actions.filter((action) => !!search.matchName(action.label))
}
