import { describe, expect, test } from 'bun:test'
import { MAX_TASK_SOURCES, taskSourceKey, type TaskSource } from '@solus/contracts/task-sources'
import type { TaskSourceHealth, TaskSourceOptions, TaskSourceState } from '@solus/contracts/task-types'
import {
  defaultSourceKeyOf,
  manualSourceChoice,
  manualSourceKey,
  parseManualTaskSource,
  matchingChoices,
  sourceChoiceGroups,
  sourceConnectionNotes,
  sourceHealthNote,
  sourceSetupTrigger,
  taskSourceLabel,
  withDefaultTaskSource,
  withTaskSource,
  withoutTaskSource,
} from '@solus/workspace-ui/components/tasks/sources/lib/task-source-setup'

const REPO: TaskSource = { kind: 'github-repo', owner: 'acme', repo: 'app' }
const BOARD: TaskSource = { kind: 'github-project', owner: 'acme', number: 7 }
const JIRA: TaskSource = { kind: 'jira-project', cloudId: 'cloud-1', projectKey: 'SOL' }
const JIRA_BOARD: TaskSource = { kind: 'jira-board', cloudId: 'cloud-1', boardId: 4 }

describe('adding a task source', () => {
  test('the first source of a project becomes its default source', () => {
    // WHY: a project with sources always has a default source: it is where a
    // new task is created, by a person and by `create_task`.
    expect(withTaskSource({}, REPO)).toEqual({ taskSources: [REPO], defaultTaskSource: 'github-repo:acme/app' })
  })

  test('a second source does not take the default', () => {
    const config = { taskSources: [REPO], defaultTaskSource: taskSourceKey(REPO) }
    expect(withTaskSource(config, BOARD)).toEqual({ taskSources: [REPO, BOARD], defaultTaskSource: 'github-repo:acme/app' })
  })

  test('a source the project lists already is refused, also in another case', () => {
    // WHY: GitHub names do not distinguish case. The same repository twice
    // would show each of its tasks from two sources with one key.
    const config = { taskSources: [REPO] }
    expect(withTaskSource(config, { kind: 'github-repo', owner: 'ACME', repo: 'App' })).toBeNull()
    // Another Project of the same owner is another source.
    expect(withTaskSource({ taskSources: [BOARD] }, { kind: 'github-project', owner: 'acme', number: 8 })).not.toBeNull()
  })

  test('a project holds at most the number of sources the host accepts', () => {
    // WHY: the host refuses a longer list, so the setup must not let a person
    // build one and then lose it on save.
    const full = Array.from({ length: MAX_TASK_SOURCES }, (_, index): TaskSource => ({ kind: 'github-project', owner: 'acme', number: index + 1 }))
    expect(withTaskSource({ taskSources: full }, REPO)).toBeNull()
    expect(withTaskSource({ taskSources: full.slice(1) }, REPO)?.taskSources).toHaveLength(MAX_TASK_SOURCES)
  })

  test('a config that names a default the project no longer lists gets a real default with the next source', () => {
    // WHY: a hand-edited config can name a source that is gone. The default
    // is then the first source, and a save must write that down.
    const config = { taskSources: [REPO], defaultTaskSource: 'github-project:gone/1' }
    expect(defaultSourceKeyOf(config)).toBe('github-repo:acme/app')
    expect(withTaskSource(config, BOARD)?.defaultTaskSource).toBe('github-repo:acme/app')
  })
})

describe('removing a task source', () => {
  const config = { taskSources: [REPO, BOARD, JIRA], defaultTaskSource: taskSourceKey(BOARD) }

  test('a source that is not the default leaves the default alone', () => {
    expect(withoutTaskSource(config, taskSourceKey(REPO))).toEqual({ taskSources: [BOARD, JIRA], defaultTaskSource: taskSourceKey(BOARD) })
  })

  test('when the default source goes, the first source that stays becomes the default', () => {
    // WHY: a project with sources always has a default source. Without the
    // move, a new task would have nowhere to go.
    expect(withoutTaskSource(config, taskSourceKey(BOARD))).toEqual({ taskSources: [REPO, JIRA], defaultTaskSource: taskSourceKey(REPO) })
  })

  test('a project with no source left has no default source', () => {
    // WHY: a project with no task source has no tasks (decision 11). A
    // default that names a removed source would point `create_task` at nothing.
    expect(withoutTaskSource({ taskSources: [REPO], defaultTaskSource: taskSourceKey(REPO) }, taskSourceKey(REPO)))
      .toEqual({ taskSources: [], defaultTaskSource: undefined })
  })

  test('a source key the project does not list changes nothing', () => {
    expect(withoutTaskSource(config, 'jira-board:cloud-1/99')).toEqual(config)
  })
})

describe('choosing the default source', () => {
  test('one of the project sources can become the default', () => {
    const config = { taskSources: [REPO, BOARD], defaultTaskSource: taskSourceKey(REPO) }
    expect(withDefaultTaskSource(config, taskSourceKey(BOARD))).toEqual({ taskSources: [REPO, BOARD], defaultTaskSource: 'github-project:acme/7' })
  })

  test('a source the project does not list cannot be the default', () => {
    // WHY: a new task is created in the default source of the project.
    expect(withDefaultTaskSource({ taskSources: [REPO] }, taskSourceKey(JIRA))).toBeNull()
  })

  test('a config that names no default has the first source as its default', () => {
    expect(defaultSourceKeyOf({ taskSources: [JIRA, REPO] })).toBe('jira-project:cloud-1/SOL')
    expect(defaultSourceKeyOf({})).toBeUndefined()
  })
})

describe('what a source row says about its last read', () => {
  test('a source the host read whole says nothing', () => {
    expect(sourceHealthNote({ health: 'ok' })).toBeNull()
  })

  test('each reason a source cannot be read has its own label, and all are failures', () => {
    // WHY: the fix is different for each: connect, connect again for a
    // missing permission, ask for access, or wait. One "error" label would
    // send a person to the wrong place.
    const labels: Array<[Exclude<TaskSourceHealth, 'ok'>, string]> = [
      ['not_connected', 'Not connected'],
      ['reconnect', 'Reconnect'],
      ['no_access', 'No access'],
      ['error', 'Read failed'],
    ]
    for (const [health, label] of labels) {
      const note = sourceHealthNote({ health })
      expect(note?.label).toBe(label)
      expect(note?.tone).toBe('failure')
      expect(note?.message.length).toBeGreaterThan(0)
    }
    expect(new Set(labels.map(([health]) => sourceHealthNote({ health })?.message)).size).toBe(labels.length)
  })

  test('the words of the host replace the general message', () => {
    // WHY: the host knows the exact cause, such as the missing Jira Software scope.
    expect(sourceHealthNote({ health: 'reconnect', message: 'Connect Atlassian again for the Jira Software scopes.' }))
      .toEqual({ label: 'Reconnect', tone: 'failure', message: 'Connect Atlassian again for the Jira Software scopes.' })
  })

  test('a truncated source is a warning that points at search', () => {
    // WHY: the tasks on screen are correct but not complete. Search is the
    // way to the rest, so the note must say so.
    const note = sourceHealthNote({ health: 'ok', truncated: true })
    expect(note).toMatchObject({ label: 'Truncated', tone: 'warning' })
    expect(note?.message).toContain('Search')
  })

  test('a source that cannot be read outranks one that is only truncated', () => {
    // WHY: the tasks on screen are then an old copy, or none. That is the
    // more serious fact.
    expect(sourceHealthNote({ health: 'no_access', truncated: true })?.label).toBe('No access')
  })
})

describe('the header control', () => {
  function state(label: string, health: TaskSourceHealth = 'ok'): TaskSourceState {
    return { sourceKey: `github-repo:acme/${label}`, source: REPO, label, columns: [], health }
  }

  test('a project with no source invites one, and names the four kinds', () => {
    // WHY: with no source the page has no tasks. The control must read as a
    // decision to make, not as a setting that is already correct.
    const trigger = sourceSetupTrigger([])
    expect(trigger).toMatchObject({ label: 'Add a task source', unset: true, needsAttention: false })
    for (const kind of ['GitHub repository', 'GitHub Project', 'Jira project', 'Jira board']) expect(trigger.title).toContain(kind)
  })

  test('one source is named, more are counted, and the title names each', () => {
    expect(sourceSetupTrigger([state('acme/app')])).toMatchObject({ label: 'acme/app', unset: false, needsAttention: false })
    const trigger = sourceSetupTrigger([state('acme/app'), state('Roadmap'), state('SOL')])
    expect(trigger.label).toBe('3 task sources')
    expect(trigger.title).toBe('Tasks of this project come from acme/app, Roadmap, SOL')
  })

  test('a source that cannot be read puts a warning on the control', () => {
    // WHY: the control is in the page header. It is the one place that shows
    // a broken source when the page shows all sources together.
    const trigger = sourceSetupTrigger([state('acme/app'), state('Roadmap', 'reconnect'), state('SOL', 'not_connected')])
    expect(trigger.needsAttention).toBe(true)
    expect(trigger.title).toBe('2 of 3 task sources cannot be read')
    expect(sourceSetupTrigger([state('acme/app', 'error')]).title).toBe('1 of 1 task source cannot be read')
  })
})

describe('what can be added', () => {
  const options: TaskSourceOptions = {
    github: {
      connected: true,
      login: 'octocat',
      hasProjectScope: true,
      originRepository: { owner: 'acme', repo: 'app' },
      projects: [{ owner: 'acme', number: 7, title: 'Roadmap' }, { owner: 'acme', number: 9, title: 'Bugs' }],
    },
    jira: {
      connected: true,
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      projects: [{ projectKey: 'SOL', name: 'Solus' }],
      boards: [{ boardId: 4, name: 'Sprint board', projectKey: 'SOL' }],
    },
  }
  const groupOf = (groups: ReturnType<typeof sourceChoiceGroups>, kind: TaskSource['kind']) => {
    const group = groups.find((candidate) => candidate.kind === kind)
    if (!group) throw new Error(`No group for ${kind}`)
    return group
  }

  test('offers the four kinds, in one order, each choice with the source it adds', () => {
    // WHY: a project can read tasks from boards and from the plain scopes
    // (decision 5). The origin repository is the suggested first source.
    const groups = sourceChoiceGroups(options, [])

    expect(groups.map((group) => group.kind)).toEqual(['github-repo', 'github-project', 'jira-project', 'jira-board'])
    expect(groupOf(groups, 'github-repo').choices).toEqual([
      expect.objectContaining({ source: REPO, sourceKey: 'github-repo:acme/app', label: 'acme/app', detail: 'Repository · origin' }),
    ])
    expect(groupOf(groups, 'github-project').choices.map((choice) => [choice.label, choice.detail, choice.sourceKey])).toEqual([
      ['Roadmap', 'Project · acme #7', 'github-project:acme/7'],
      ['Bugs', 'Project · acme #9', 'github-project:acme/9'],
    ])
    expect(groupOf(groups, 'jira-project').choices.map((choice) => choice.source)).toEqual([JIRA])
    expect(groupOf(groups, 'jira-board').choices.map((choice) => choice.source)).toEqual([JIRA_BOARD])
  })

  test('a source the project lists already is not offered again', () => {
    // WHY: adding it is refused, so offering it is a control that does nothing.
    const groups = sourceChoiceGroups(options, [BOARD, JIRA])

    expect(groupOf(groups, 'github-project').choices.map((choice) => choice.label)).toEqual(['Bugs'])
    expect(groupOf(groups, 'jira-project').choices).toEqual([])
  })

  test('a list that is empty for an ordinary reason needs no sentence', () => {
    // WHY: "each board is a source already" and "no Project found" are not
    // problems to repair. One line for each of them made the menu hard to read.
    expect(sourceConnectionNotes(options)).toEqual([])
    expect(sourceConnectionNotes({ ...options, github: { connected: true, hasProjectScope: true, projects: [] } })).toEqual([])
    expect(sourceConnectionNotes({ ...options, jira: { ...options.jira, projects: [], boards: [] } })).toEqual([])
  })

  test('a provider that is not connected says so, one time', () => {
    // WHY: a missing choice reads as "Solus cannot do this", when the truth is
    // one connection away.
    expect(sourceConnectionNotes({ ...options, github: { connected: false, projects: [] } }))
      .toEqual(['Connect GitHub in Settings to add repositories and Projects.'])
    expect(sourceConnectionNotes({ ...options, jira: { connected: false, projects: [], boards: [] } }))
      .toEqual(['Connect Atlassian in Settings to add Jira projects and boards.'])
  })

  test('a GitHub connection that cannot read Projects asks for a new connection, not for a Project', () => {
    // WHY: an empty list here is not "you have no Projects". The connection
    // lacks the `project` scope (plan §4.6), and only a reconnect repairs it.
    expect(sourceConnectionNotes({ ...options, github: { ...options.github, hasProjectScope: false, projects: [] } }))
      .toEqual(['Connect GitHub again to let Solus read Projects.'])
  })

  test('an Atlassian connection with no Jira site offers nothing and says why', () => {
    // WHY: a source needs the cloud id. Projects listed without one could not
    // be saved as sources.
    const noSite = { ...options, jira: { ...options.jira, cloudId: undefined } }

    expect(groupOf(sourceChoiceGroups(noSite, []), 'jira-project').choices).toEqual([])
    expect(sourceConnectionNotes(noSite)).toEqual(['This Atlassian connection does not reach Jira.'])
  })

  test('a failed read of the boards is said in the words of the host', () => {
    // WHY: a missing Jira Software scope is not "no Jira board on the
    // connected site". That confident, wrong answer sends a person to look at
    // their Jira site instead of at their connection.
    const boardsError = 'Connect Atlassian again to let Solus read Jira boards.'

    expect(sourceConnectionNotes({ ...options, jira: { ...options.jira, boards: [], boardsError } })).toEqual([boardsError])
  })

  test('the search of the menu matches the kind, the label and the detail', () => {
    const groups = sourceChoiceGroups(options, [])
    const projects = groupOf(groups, 'github-project')

    expect(matchingChoices(projects, 'road').map((choice) => choice.label)).toEqual(['Roadmap'])
    expect(matchingChoices(projects, '#9').map((choice) => choice.label)).toEqual(['Bugs'])
    expect(matchingChoices(projects, 'github project')).toHaveLength(2)
    expect(matchingChoices(projects, '  ')).toHaveLength(2)
    expect(matchingChoices(groupOf(groups, 'jira-project'), 'solus').map((choice) => choice.label)).toEqual(['SOL'])
  })
})

describe('a source in words before a host has read it', () => {
  test('each kind has a label a person can tell apart', () => {
    expect(taskSourceLabel(REPO)).toBe('acme/app')
    expect(taskSourceLabel(BOARD)).toBe('acme #7')
    expect(taskSourceLabel(JIRA)).toBe('SOL')
    expect(taskSourceLabel(JIRA_BOARD)).toBe('Board 4')
  })
})

describe('a source that a person types or pastes', () => {
  // WHY: the host lists only the origin repository and the Projects the
  // connection can see. A person must be able to name another repository or
  // Project, and the saved source must be the same shape the host reads.
  test('owner/repo names a GitHub repository', () => {
    expect(parseManualTaskSource('acme/app')).toEqual({ kind: 'github-repo', owner: 'acme', repo: 'app' })
    expect(parseManualTaskSource('  acme/app.js  ')).toEqual({ kind: 'github-repo', owner: 'acme', repo: 'app.js' })
  })

  test('a github.com repository URL names the repository, in each form a person copies', () => {
    const expected = { kind: 'github-repo', owner: 'acme', repo: 'app' }
    expect(parseManualTaskSource('https://github.com/acme/app')).toEqual(expected)
    expect(parseManualTaskSource('https://github.com/acme/app/')).toEqual(expected)
    expect(parseManualTaskSource('https://github.com/acme/app.git')).toEqual(expected)
    expect(parseManualTaskSource('https://www.github.com/acme/app?tab=readme#top')).toEqual(expected)
    expect(parseManualTaskSource('github.com/acme/app')).toEqual(expected)
  })

  test('a Project URL of an organization or of a person names the Project', () => {
    expect(parseManualTaskSource('https://github.com/orgs/acme/projects/7'))
      .toEqual({ kind: 'github-project', owner: 'acme', number: 7 })
    expect(parseManualTaskSource('https://github.com/users/octocat/projects/12'))
      .toEqual({ kind: 'github-project', owner: 'octocat', number: 12 })
    // The address bar of a Project shows one of its views.
    expect(parseManualTaskSource('https://github.com/orgs/acme/projects/7/views/2?layout=board'))
      .toEqual({ kind: 'github-project', owner: 'acme', number: 7 })
  })

  test('a URL of one item inside a repository is refused', () => {
    // WHY: an issue or a pull request URL names one item. A guess that the
    // person meant the whole repository adds a source they did not ask for.
    expect(parseManualTaskSource('https://github.com/acme/app/pull/12')).toBeNull()
    expect(parseManualTaskSource('https://github.com/acme/app/issues/34')).toBeNull()
    expect(parseManualTaskSource('https://github.com/acme/app/tree/main/src')).toBeNull()
    expect(parseManualTaskSource('acme/app/issues/34')).toBeNull()
  })

  test('another host is refused', () => {
    // WHY: tasks are read from github.com only (plan §4.1). A source of
    // another host would save and then never read.
    expect(parseManualTaskSource('https://gitlab.com/acme/app')).toBeNull()
    expect(parseManualTaskSource('https://github.example.com/acme/app')).toBeNull()
    expect(parseManualTaskSource('https://github.com.evil.test/acme/app')).toBeNull()
    expect(parseManualTaskSource('gitlab.com/acme/app')).toBeNull()
    expect(parseManualTaskSource('ssh://git@github.com/acme/app')).toBeNull()
  })

  test('a text that names no source is refused', () => {
    for (const text of ['', 'acme', 'acme/', '/app', 'acme app/x', '-acme/app', 'acme/..',
      'https://github.com/acme', 'https://github.com/orgs/acme', 'https://github.com/orgs/acme/projects',
      'https://github.com/orgs/acme/projects/0', 'https://github.com/orgs/acme/projects/abc',
      'https://github.com/orgs/acme/projects/7/settings', 'https://github.com/orgs/acme/teams/core']) {
      expect(parseManualTaskSource(text)).toBeNull()
    }
  })

  test('the typed source is offered when the project does not list it', () => {
    const choice = manualSourceChoice('other/repo', [REPO], [])
    expect(choice?.source).toEqual({ kind: 'github-repo', owner: 'other', repo: 'repo' })
    expect(choice?.sourceKey).toBe('github-repo:other/repo')
    expect(choice?.label).toBe('other/repo')
  })

  test('a source the project lists already is not offered again, in any spelling', () => {
    // WHY: a source key does not distinguish case, so `Acme/App` is the same
    // source; a second copy would be dropped by the host and confuse the list.
    expect(manualSourceChoice('https://github.com/Acme/App', [REPO], [])).toBeNull()
    expect(manualSourceKey('https://github.com/Acme/App')).toBe(taskSourceKey(REPO))
    expect(manualSourceKey('not a source')).toBeNull()
  })

  test('a pasted URL of a source the menu offers gives the offered choice', () => {
    // WHY: the offered choice has the host's label (the Project's title). The
    // URL text does not match that label, so without this the menu says
    // "nothing matches" for a Project it lists.
    const offered = {
      source: BOARD,
      sourceKey: taskSourceKey(BOARD),
      label: 'Roadmap',
      detail: 'acme #7',
      searchText: 'github project roadmap acme #7',
    }
    const groups = [{ kind: BOARD.kind, choices: [offered] }]
    expect(manualSourceChoice('https://github.com/orgs/acme/projects/7', [], groups)).toBe(offered)
  })
})
