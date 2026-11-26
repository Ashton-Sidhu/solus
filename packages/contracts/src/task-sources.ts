// Where a project reads its tasks from, and how a task is named.
// GitHub and Jira own every task; Solus names one by the provider's stable id
// (docs/plans/provider-owned-tasks.md §4).

import { z } from 'zod'

const nameSchema = z.string().trim().min(1).max(256)

/** One place a project reads tasks from. A board (a GitHub Project, a Jira
 *  board) is a source that has columns. */
export const issueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github-repo'), owner: nameSchema, repo: nameSchema }),
  z.object({ kind: z.literal('github-project'), owner: nameSchema, number: z.number().int().positive() }),
  z.object({ kind: z.literal('linear-team'), workspaceId: nameSchema, teamId: nameSchema, teamKey: nameSchema }),
  z.object({ kind: z.literal('jira-project'), cloudId: nameSchema, projectKey: nameSchema }),
  z.object({ kind: z.literal('jira-board'), cloudId: nameSchema, boardId: z.number().int().positive() }),
])
export type IssueSource = z.infer<typeof issueSourceSchema>

export const MAX_ISSUE_SOURCES = 32

/** `open`, `active` or `done`: the one fact Solus derives from a provider
 *  column, for agent rules and for a view that mixes sources. */
export type IssueStatusCategory = 'open' | 'active' | 'done'

/**
 * Names a source independent of the project that lists it, so two projects
 * with the same board share one cache and one refresh. GitHub names do not
 * distinguish case; Jira project keys are upper case.
 */
export function issueSourceKey(source: IssueSource): string {
  switch (source.kind) {
    case 'github-repo':
      return `github-repo:${source.owner.toLowerCase()}/${source.repo.toLowerCase()}`
    case 'github-project':
      return `github-project:${source.owner.toLowerCase()}/${source.number}`
    case 'linear-team':
      return `linear-team:${source.workspaceId}/${source.teamId}`
    case 'jira-project':
      return `jira-project:${source.cloudId}/${source.projectKey.toUpperCase()}`
    case 'jira-board':
      return `jira-board:${source.cloudId}/${source.boardId}`
  }
}

export function issueSourceProvider(source: IssueSource): IssueRef['provider'] {
  if (source.kind === 'linear-team') return 'linear'
  return source.kind === 'github-repo' || source.kind === 'github-project' ? 'github' : 'jira'
}

/** What tells where a new task belongs when nobody names a source. */
export interface IssueSourceHints {
  /** The sources that list the task the work is about, such as the task a session works on. */
  taskSourceKeys?: readonly string[]
  /** The GitHub repository that the work is done in: the checkout of a session. */
  repository?: { owner: string; repo: string } | null
  /** The source that the person chose for their last new task. */
  lastSourceKey?: string | null
}

/**
 * The source that a new task goes to when nobody names one (docs/tasks.md).
 * There is no default source to set: the work says where its task belongs.
 * In this order: a source of the task the work is about, in the person's order
 * of sources; the source of the GitHub repository the work is done in; the
 * source the person chose last; the person's only source. Null when no hint
 * names one of several sources: then the person or the agent chooses.
 */
export function inferIssueSourceKey(sourceKeys: readonly string[], hints: IssueSourceHints = {}): string | null {
  const ofTask = sourceKeys.find((sourceKey) => hints.taskSourceKeys?.includes(sourceKey))
  if (ofTask) return ofTask
  if (hints.repository) {
    const ofRepository = issueSourceKey({ kind: 'github-repo', ...hints.repository })
    if (sourceKeys.includes(ofRepository)) return ofRepository
  }
  if (hints.lastSourceKey && sourceKeys.includes(hints.lastSourceKey)) return hints.lastSourceKey
  return sourceKeys.length === 1 ? sourceKeys[0] : null
}

/**
 * The identity of a task. `id` is the provider's stable id, not the reference
 * a person reads: a GitHub issue keeps its node id when it moves to another
 * repository, and a Jira issue keeps its numeric id when its key changes.
 */
export type IssueRef =
  | { provider: 'github'; id: string }
  | { provider: 'jira'; cloudId: string; id: string }
  | { provider: 'linear'; workspaceId: string; id: string }

/** The string form of a task ref, and the only task id in Solus. */
export function issueKey(ref: IssueRef): string {
  if (ref.provider === 'linear') return `linear:${ref.workspaceId}:${ref.id}`
  return ref.provider === 'github' ? `github:${ref.id}` : `jira:${ref.cloudId}:${ref.id}`
}

/** Null for a string that is not a task key, such as an id from before tasks
 *  were provider-owned. */
export function parseIssueKey(key: string): IssueRef | null {
  const [provider, ...rest] = key.split(':')
  if (provider === 'github' && rest.length === 1 && rest[0]) return { provider, id: rest[0] }
  if (provider === 'linear' && rest.length === 2 && rest[0] && rest[1]) return { provider, workspaceId: rest[0], id: rest[1] }
  if (provider === 'jira' && rest.length === 2 && rest[0] && rest[1]) {
    return { provider, cloudId: rest[0], id: rest[1] }
  }
  return null
}
