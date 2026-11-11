// The task sources of a project, as the source setup shows and changes them.
// Shaping only: the save itself is a project config write, and the host reads
// the sources again after it (docs/plans/provider-owned-tasks.md §4.2, §7).
import type { ProjectConfig } from '@solus/contracts/types'
import { MAX_TASK_SOURCES, taskSourceKey, type TaskSource } from '@solus/contracts/task-sources'
import type { TaskSourceHealth, TaskSourceOptions, TaskSourceState } from '@solus/contracts/task-types'

type TaskSourceConfig = Pick<ProjectConfig, 'taskSources' | 'defaultTaskSource'>

/** What each source kind is called. A board is a source that has columns. */
export const SOURCE_KIND_NAMES = {
  'github-repo': 'GitHub repository',
  'github-project': 'GitHub Project',
  'jira-project': 'Jira project',
  'jira-board': 'Jira board',
} satisfies Record<TaskSource['kind'], string>

/** A source in words, before a host has read it and can give its own label. */
export function taskSourceLabel(source: TaskSource): string {
  switch (source.kind) {
    case 'github-repo':
      return `${source.owner}/${source.repo}`
    case 'github-project':
      return `${source.owner} #${source.number}`
    case 'jira-project':
      return source.projectKey
    case 'jira-board':
      return `Board ${source.boardId}`
  }
}

// ── Changes of the project config ──

/**
 * Add a source to a project. The first source becomes the default source, so
 * a project with sources always has one. Null when the project lists the
 * source already or holds the most sources a project can.
 */
export function withTaskSource(config: TaskSourceConfig, source: TaskSource): TaskSourceConfig | null {
  const sources = config.taskSources ?? []
  const sourceKey = taskSourceKey(source)
  if (sources.length >= MAX_TASK_SOURCES) return null
  if (sources.some((held) => taskSourceKey(held) === sourceKey)) return null
  return {
    taskSources: [...sources, source],
    defaultTaskSource: defaultSourceKeyOf(config) ?? sourceKey,
  }
}

/**
 * Remove a source from a project. When it was the default source, the first
 * source that stays becomes the default. A project with no source has no
 * default source and no tasks.
 */
export function withoutTaskSource(config: TaskSourceConfig, sourceKey: string): TaskSourceConfig {
  const sources = (config.taskSources ?? []).filter((held) => taskSourceKey(held) !== sourceKey)
  const heldDefault = defaultSourceKeyOf(config)
  const defaultSource = heldDefault && heldDefault !== sourceKey ? heldDefault : sources[0] ? taskSourceKey(sources[0]) : undefined
  return { taskSources: sources, defaultTaskSource: defaultSource }
}

/** Make one of the project's sources the default source. Null when the project
 *  does not list it. */
export function withDefaultTaskSource(config: TaskSourceConfig, sourceKey: string): TaskSourceConfig | null {
  const sources = config.taskSources ?? []
  if (!sources.some((held) => taskSourceKey(held) === sourceKey)) return null
  return { taskSources: sources, defaultTaskSource: sourceKey }
}

/** The default source of a config: the one it names, when the project still
 *  lists it, else the first source. */
export function defaultSourceKeyOf(config: TaskSourceConfig): string | undefined {
  const sourceKeys = (config.taskSources ?? []).map(taskSourceKey)
  return config.defaultTaskSource && sourceKeys.includes(config.defaultTaskSource)
    ? config.defaultTaskSource
    : sourceKeys[0]
}

// ── Health ──

export type SourceHealthTone = 'warning' | 'failure'

export interface SourceHealthNote {
  label: string
  tone: SourceHealthTone
  /** What the host said, or what a person can do about it. */
  message: string
}

const HEALTH_NOTES = {
  not_connected: { label: 'Not connected', tone: 'failure', message: 'Connect the provider in Settings to read this source.' },
  reconnect: { label: 'Reconnect', tone: 'failure', message: 'The connection lacks a permission this source needs. Connect the provider again in Settings.' },
  no_access: { label: 'No access', tone: 'failure', message: 'Your provider account cannot read this source.' },
  error: { label: 'Read failed', tone: 'failure', message: 'The provider did not answer the last read.' },
} satisfies Record<Exclude<TaskSourceHealth, 'ok'>, SourceHealthNote>

/**
 * What a source row says about its last read, or null when there is nothing to
 * say. A source that cannot be read outranks one that is only truncated: the
 * tasks on screen are then an old copy, or none.
 */
export function sourceHealthNote(state: Pick<TaskSourceState, 'health' | 'message' | 'truncated'>): SourceHealthNote | null {
  if (state.health !== 'ok') {
    const note = HEALTH_NOTES[state.health]
    return state.message ? { ...note, message: state.message } : note
  }
  if (state.truncated) {
    return {
      label: 'Truncated',
      tone: 'warning',
      message: 'This source holds more tasks than Solus read. Search reaches the rest.',
    }
  }
  return null
}

// ── The header control ──

export interface SourceSetupTrigger {
  label: string
  title: string
  /** The project has no source: the control invites rather than reports. */
  unset: boolean
  /** A source cannot be read, so the control shows a warning mark. */
  needsAttention: boolean
}

export function sourceSetupTrigger(sources: readonly TaskSourceState[]): SourceSetupTrigger {
  if (sources.length === 0) {
    return {
      label: 'Add a task source',
      title: 'This project has no task source. Add a GitHub repository, a GitHub Project, a Jira project or a Jira board.',
      unset: true,
      needsAttention: false,
    }
  }
  const unhealthy = sources.filter((source) => source.health !== 'ok')
  const label = sources.length === 1 ? sources[0].label : `${sources.length} task sources`
  return {
    label,
    title: unhealthy.length
      ? `${unhealthy.length} of ${sources.length} task source${sources.length === 1 ? '' : 's'} cannot be read`
      : `Tasks of this project come from ${sources.map((source) => source.label).join(', ')}`,
    unset: false,
    needsAttention: unhealthy.length > 0,
  }
}

// ── What can be added ──

export interface SourceChoice {
  source: TaskSource
  sourceKey: string
  label: string
  /** A second, quieter part: a project's name beside its key. */
  detail?: string
  /** The text the menu's search matches. */
  searchText: string
}

export interface SourceChoiceGroup {
  kind: TaskSource['kind']
  choices: SourceChoice[]
}

/** What a source is, in one or two words beside its name. */
export const SOURCE_KIND_SHORT_NAMES = {
  'github-repo': 'Repository',
  'github-project': 'Project',
  'jira-project': 'Jira project',
  'jira-board': 'Jira board',
} satisfies Record<TaskSource['kind'], string>

/**
 * The sources a person can add to a project, by kind, without the sources the
 * project lists already. The detail of a choice says its kind, so the menu
 * needs no heading for each kind.
 */
export function sourceChoiceGroups(
  options: TaskSourceOptions,
  configured: readonly TaskSource[],
): SourceChoiceGroup[] {
  const held = new Set(configured.map(taskSourceKey))
  const group = (kind: TaskSource['kind'], sources: Array<{ source: TaskSource; label: string; detail?: string }>): SourceChoiceGroup => ({
    kind,
    choices: sources
      .map(({ source, label, detail }) => ({
        source,
        sourceKey: taskSourceKey(source),
        label,
        detail: detail ? `${SOURCE_KIND_SHORT_NAMES[kind]} · ${detail}` : SOURCE_KIND_SHORT_NAMES[kind],
        searchText: `${SOURCE_KIND_NAMES[kind]} ${label} ${detail ?? ''}`.toLowerCase(),
      }))
      .filter((choice) => !held.has(choice.sourceKey)),
  })

  const { github, jira } = options
  const origin = github.originRepository
  const cloudId = jira.cloudId

  return [
    group('github-repo', origin ? [{ source: { kind: 'github-repo', owner: origin.owner, repo: origin.repo }, label: `${origin.owner}/${origin.repo}`, detail: 'origin' }] : []),
    group('github-project', github.projects.map((project) => ({
      source: { kind: 'github-project', owner: project.owner, number: project.number },
      label: project.title,
      detail: `${project.owner} #${project.number}`,
    }))),
    group('jira-project', cloudId ? jira.projects.map((project) => ({
      source: { kind: 'jira-project', cloudId, projectKey: project.projectKey },
      label: project.projectKey,
      detail: project.name,
    })) : []),
    group('jira-board', cloudId ? jira.boards.map((board) => ({
      source: { kind: 'jira-board', cloudId, boardId: board.boardId },
      label: board.name,
      detail: board.projectKey,
    })) : []),
  ]
}

/**
 * What a person must repair before a provider offers its sources. Only a
 * connection problem is said: a list that is empty because each source is added
 * already, or because the provider has none, needs no sentence. Without this,
 * a missing choice reads as "Solus cannot do this", when the truth is one
 * connection away.
 */
export function sourceConnectionNotes(options: TaskSourceOptions): string[] {
  const { github, jira } = options
  const notes: string[] = []
  if (!github.connected) notes.push('Connect GitHub in Settings to add repositories and Projects.')
  else if (github.hasProjectScope === false) notes.push('Connect GitHub again to let Solus read Projects.')
  if (!jira.connected) notes.push('Connect Atlassian in Settings to add Jira projects and boards.')
  else if (!jira.cloudId) notes.push('This Atlassian connection does not reach Jira.')
  else if (jira.boardsError) notes.push(jira.boardsError)
  return notes
}

/** The choices of a group that a search text keeps. */
export function matchingChoices(group: SourceChoiceGroup, query: string): SourceChoice[] {
  const needle = query.trim().toLowerCase()
  return needle ? group.choices.filter((choice) => choice.searchText.includes(needle)) : group.choices
}

// ── A source that a person types or pastes ──

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
// A GitHub login: letters, digits and single hyphens, 39 characters at most.
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/
/** The first path segment of a github.com URL that is not an account. */
const GITHUB_RESERVED_OWNERS = new Set(['orgs', 'users'])

/**
 * The source that a typed or pasted text names, or null.
 *
 * The choices that the host lists are the origin repository and the Projects
 * the connection can see. A person can also want another repository, or a
 * Project the list did not reach, so the setup takes:
 *
 * - `owner/repo`
 * - a repository URL: `https://github.com/owner/repo`
 * - a Project URL: `https://github.com/orgs/<owner>/projects/<n>` or
 *   `https://github.com/users/<owner>/projects/<n>`, with or without a view
 *
 * Tasks are read from github.com only, so a URL of another host is refused.
 * A URL of something inside a repository (an issue, a pull request, a file)
 * is refused too: it names one item, and a guess that the person meant the
 * whole repository would add a source they did not ask for. Nothing here
 * checks that the source exists; the host reports that after its first read.
 */
export function parseManualTaskSource(text: string): TaskSource | null {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  const segments = githubPathSegments(trimmed)
  if (!segments) return null
  const [first, second] = segments
  if (GITHUB_RESERVED_OWNERS.has(first ?? '')) return projectSourceOf(segments)
  if (segments.length !== 2 || !first || !second) return null
  const repo = second.endsWith('.git') ? second.slice(0, -'.git'.length) : second
  if (!GITHUB_OWNER.test(first) || !GITHUB_REPO.test(repo) || repo === '.' || repo === '..') return null
  return { kind: 'github-repo', owner: first, repo }
}

/** `orgs/<owner>/projects/<n>` or `users/<owner>/projects/<n>`, then nothing
 *  or `views/<m>`. Another path under `orgs` or `users` is not a Project. */
function projectSourceOf(segments: readonly string[]): TaskSource | null {
  const [, owner, section, number, ...rest] = segments
  if (!owner || !GITHUB_OWNER.test(owner)) return null
  if (section !== 'projects' || !number || !/^[1-9]\d*$/.test(number)) return null
  if (rest.length !== 0 && !(rest.length === 2 && rest[0] === 'views')) return null
  return { kind: 'github-project', owner, number: Number(number) }
}

/** The path segments of a github.com address, or of a bare `owner/repo`.
 *  Null for a text that names another host or is not an address. */
function githubPathSegments(text: string): string[] | null {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  const firstSegment = text.split('/')[0] ?? ''
  // `github.com/owner/repo` without a scheme is still an address. A first
  // segment with a dot that is not GitHub is another host, not an owner.
  const looksLikeHost = !hasScheme && firstSegment.includes('.')
  if (!hasScheme && !looksLikeHost) return text.split('/').filter(Boolean)
  if (!URL.canParse(hasScheme ? text : `https://${text}`)) return null
  const url = new URL(hasScheme ? text : `https://${text}`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null
  return url.pathname.split('/').filter(Boolean)
}

/**
 * The choice for a typed or pasted source, or null when the text names no
 * source or names one that the project lists already. When the menu offers
 * the source too, the answer is the offered choice: it has the host's label,
 * and a pasted URL does not match that label as search text.
 */
export function manualSourceChoice(
  query: string,
  configured: readonly TaskSource[],
  groups: readonly SourceChoiceGroup[],
): SourceChoice | null {
  const source = parseManualTaskSource(query)
  if (!source) return null
  const sourceKey = taskSourceKey(source)
  if (configured.some((held) => taskSourceKey(held) === sourceKey)) return null
  for (const group of groups) {
    const offered = group.choices.find((choice) => choice.sourceKey === sourceKey)
    if (offered) return offered
  }
  return {
    source,
    sourceKey,
    label: taskSourceLabel(source),
    detail: SOURCE_KIND_NAMES[source.kind],
    searchText: query.trim().toLowerCase(),
  }
}

/** The source key of a typed or pasted source, or null when the text names none. */
export function manualSourceKey(query: string): string | null {
  const source = parseManualTaskSource(query)
  return source ? taskSourceKey(source) : null
}
