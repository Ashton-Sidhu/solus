import { parseManualTaskSource } from '@solus/client-core/task-source-input'
export { parseManualTaskSource } from '@solus/client-core/task-source-input'
// The person's task sources, as the source setup shows and changes them.
// Shaping only: the save itself is a write of the personal settings, and the
// task host reads the sources again after it (docs/tasks.md).
import type { PersonalSettings } from '@solus/contracts/settings'
import { MAX_TASK_SOURCES, taskSourceKey, type TaskSource } from '@solus/contracts/task-sources'
import type { TaskSourceHealth, TaskSourceOptions, TaskSourceState } from '@solus/contracts/task-types'

type TaskSourceConfig = Pick<PersonalSettings, 'taskSources'>

/** What each source kind is called. A board is a source that has columns. */
export const SOURCE_KIND_NAMES = {
  'github-repo': 'GitHub repository',
  'github-project': 'GitHub Project',
  'jira-project': 'Jira project',
  'linear-team': 'Linear team',
  'jira-board': 'Jira board',
} satisfies Record<TaskSource['kind'], string>

/** A source in words, before a host has read it and can give its own label. */
export function taskSourceLabel(source: TaskSource): string {
  switch (source.kind) {
    case 'github-repo':
      return `${source.owner}/${source.repo}`
    case 'github-project':
      return `${source.owner} #${source.number}`
    case 'linear-team': return source.teamKey
    case 'jira-project':
      return source.projectKey
    case 'jira-board':
      return `Board ${source.boardId}`
  }
}

// ── Changes of the personal settings ──

/** Add a source. Null when the person has the source already or has the most
 *  sources a person can. */
export function withTaskSource(config: TaskSourceConfig, source: TaskSource): TaskSourceConfig | null {
  const sources = config.taskSources
  const sourceKey = taskSourceKey(source)
  if (sources.length >= MAX_TASK_SOURCES) return null
  if (sources.some((held) => taskSourceKey(held) === sourceKey)) return null
  return { taskSources: [...sources, source] }
}

/** Remove a source. A person with no source has no tasks. */
export function withoutTaskSource(config: TaskSourceConfig, sourceKey: string): TaskSourceConfig {
  return { taskSources: config.taskSources.filter((held) => taskSourceKey(held) !== sourceKey) }
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
  not_connected: { label: 'Not connected', tone: 'failure', message: 'Connect the provider to read this source.' },
  // The words of a connection everywhere else (`connectionStatusText`).
  reconnect: { label: 'Needs sign-in', tone: 'failure', message: 'The connection lacks a permission this source needs.' },
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

// ── The strip of sources ──

/** One source on the strip of the Tasks page: as the settings name it, and as
 *  the task host last read it. */
export interface SourceStripRow {
  sourceKey: string
  source: TaskSource
  /** The host's label, or the source in words before the host reads it. */
  label: string
  /** The host's last read. Null for a source that the host has not read yet. */
  state: TaskSourceState | null
}

/** The person's sources, in the order they added them. A source that the host
 *  has not read yet is on the strip at once, with its own label. */
export function sourceStripRows(config: TaskSourceConfig, states: readonly TaskSourceState[]): SourceStripRow[] {
  return config.taskSources.map((source) => {
    const sourceKey = taskSourceKey(source)
    const state = states.find((candidate) => candidate.sourceKey === sourceKey) ?? null
    return { sourceKey, source, label: state?.label ?? taskSourceLabel(source), state }
  })
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
  'linear-team': 'Linear team',
  'jira-board': 'Jira board',
} satisfies Record<TaskSource['kind'], string>

/**
 * The sources a person can add, by kind, without the sources the person has
 * already. The detail of a choice says its kind, so the menu
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
  const cloudId = jira.cloudId

  return [
    group('github-repo', github.repositories.map((repository) => ({
      source: { kind: 'github-repo', owner: repository.owner, repo: repository.repo },
      label: `${repository.owner}/${repository.repo}`,
    }))),
    group('github-project', github.projects.map((project) => ({
      source: { kind: 'github-project', owner: project.owner, number: project.number },
      label: project.title,
      detail: `${project.owner} #${project.number}`,
    }))),
    group('linear-team', options.linear?.workspaceId ? options.linear.teams.map((team) => ({ source: { kind: 'linear-team', workspaceId: options.linear!.workspaceId!, teamId: team.id, teamKey: team.key }, label: team.key, detail: team.name })) : []),
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

/** One connection problem, with the provider whose logo marks its line. */
export interface SourceConnectionNote {
  provider: 'github' | 'jira' | 'linear'
  text: string
}

/**
 * What a person must repair before a provider offers its sources. Only a
 * connection problem is said: a list that is empty because each source is added
 * already, or because the provider has none, needs no sentence. Without this,
 * a missing choice reads as "Solus cannot do this", when the truth is one
 * connection away.
 */
export function sourceConnectionNotes(options: TaskSourceOptions): SourceConnectionNote[] {
  const { github, jira, linear } = options
  const notes: SourceConnectionNote[] = []
  if (!github.connected) notes.push({ provider: 'github', text: 'Connect GitHub to add repositories and Projects.' })
  else if (github.hasProjectScope === false) notes.push({ provider: 'github', text: 'Connect GitHub again to add Projects.' })
  if (!jira.connected) notes.push({ provider: 'jira', text: 'Connect Atlassian to add Jira projects and boards.' })
  else if (!jira.cloudId) notes.push({ provider: 'jira', text: 'This Atlassian connection does not reach Jira.' })
  else if (jira.boardsError) notes.push({ provider: 'jira', text: jira.boardsError })
  if (linear?.error) notes.push({ provider: 'linear', text: linear.error })
  else if (linear && !linear.connected) notes.push({ provider: 'linear', text: 'Connect Linear to add teams.' })
  return notes
}

const PROVIDER_NAME = { github: 'GitHub', jira: 'Jira', linear: 'Linear' } satisfies Record<SourceConnectionNote['provider'], string>

/** The providers of the notes as one short phrase: "GitHub, Jira, and Linear". */
export function connectionProviderNames(notes: readonly SourceConnectionNote[]): string {
  const names = [...new Set(notes.map((note) => PROVIDER_NAME[note.provider]))]
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
}

/** The choices of a group that a search text keeps. */
export function matchingChoices(group: SourceChoiceGroup, query: string): SourceChoice[] {
  const needle = query.trim().toLowerCase()
  return needle ? group.choices.filter((choice) => choice.searchText.includes(needle)) : group.choices
}

// ── A source that a person types or pastes ──


/**
 * The choice for a typed or pasted source, or null when the text names no
 * source or names one that the person has already. When the menu offers
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
