import { describe, expect, test } from 'bun:test'
import {
  buildProjectFolders,
  buildProjectListItems,
  type ProjectListInput,
} from '@solus/workspace-ui/components/session/lib/sidebar-project-folders'
import {
  CLOSED_FOLDERS_STORAGE_KEY,
  SidebarFolderState,
} from '@solus/workspace-ui/components/session/lib/sidebar-folder-state.svelte'
import { treeKeyIntent } from '@solus/workspace-ui/components/session/lib/task-tree-keys'
import type { DraftRow } from '@solus/workspace-ui/components/session/lib/draft-list'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import type { ListProjectOption } from '@solus/workspace-ui/components/ui/list-page/list-page'

function row(id: string, groupKey: string, overrides: Partial<SidebarTask> = {}): SidebarTask {
  // SAFETY: the project view reads only identity, project, start, and attention from a row.
  return {
    id,
    key: id,
    groupKey,
    projectLabel: groupKey,
    createdAt: 0,
    status: 'idle',
    unread: false,
    lifecycle: 'active',
    ...overrides,
  } as SidebarTask
}

function draft(draftId: string, groupKey: string): DraftRow {
  // SAFETY: the project view reads only a draft's id, project, and label.
  return { draftId, groupKey, projectLabel: groupKey } as DraftRow
}

function project(key: string, label = key): ListProjectOption {
  return { key, projectKey: `/repos/${key}`, serverId: 'local', label, available: true }
}

function list(overrides: Partial<ProjectListInput> = {}) {
  return buildProjectListItems({
    drafts: [],
    sessions: [],
    shared: [],
    snoozed: [],
    completed: [],
    isSharedOpen: true,
    isSnoozedOpen: true,
    isCompletedOpen: true,
    shelfRevealTaskId: null,
    projects: [],
    isFolderOpen: () => true,
    sentAt: () => 0,
    ...overrides,
  })
}

describe('the sidebar project view', () => {
  test('puts each session in its project folder, in the column’s project order', () => {
    // WHY: the project view exists to answer "what is going on in this
    // project". Folders follow the order the project filter already shows, so
    // switching views does not reshuffle the projects the person knows.
    const items = list({
      sessions: [row('a1', 'alpha', { createdAt: 1 }), row('b1', 'beta'), row('a2', 'alpha', { createdAt: 2 })],
      projects: [project('beta'), project('alpha'), project('gamma')],
    })
    expect(items.map((item) => item.key)).toEqual([
      'folder:beta',
      'b1:card',
      'folder:alpha',
      'a2:card',
      'a1:card',
    ])
    expect(items[2]).toMatchObject({ kind: 'folder', folder: { label: 'alpha', count: 2, isOpen: true } })
  })

  test('shows only the folders the project filter leaves', () => {
    // WHY: the filter scopes the rows upstream; a project with no row in the
    // scoped list must not leave an empty folder behind.
    const items = list({
      sessions: [row('a1', 'alpha')],
      projects: [project('alpha'), project('beta')],
    })
    expect(items.filter((item) => item.kind === 'folder').map((item) => item.key)).toEqual(['folder:alpha'])
  })

  test('keeps shared, snoozed, and settled sessions on their shelves, out of the folders', () => {
    // WHY: a folder holds the person's open work. Other people's sessions and
    // shelved ones stay where the status view keeps them.
    const items = list({
      sessions: [row('a1', 'alpha')],
      shared: [row('s1', 'alpha')],
      snoozed: [row('z1', 'alpha', { lifecycle: 'snoozed' })],
      completed: [row('c1', 'alpha', { lifecycle: 'completed' })],
      projects: [project('alpha')],
    })
    expect(items.map((item) => item.key)).toEqual([
      'folder:alpha',
      'a1:card',
      'header:shared',
      's1:card',
      'header:snoozed',
      'z1:slim',
      'header:completed',
      'c1:slim',
    ])
    expect(items.find((item) => item.key === 'a1:card')).toMatchObject({ folderKey: 'alpha' })
    expect(items.find((item) => item.key === 's1:card')).not.toHaveProperty('folderKey')
  })

  test('orders a folder by the person’s latest sent prompt, newest first', () => {
    // WHY: the session you just talked to is the one you look for next. A
    // session you have not sent to here keeps its place by when it started.
    const sentAt = new Map([['old', 500]])
    const [alpha] = buildProjectFolders({
      drafts: [],
      sessions: [row('old', 'alpha', { createdAt: 100 }), row('new', 'alpha', { createdAt: 300 })],
      projects: [project('alpha')],
      isFolderOpen: () => true,
      sentAt: (task) => sentAt.get(task.id) ?? 0,
      shelfRevealTaskId: null,
    })
    expect(alpha.rows.map((task) => task.id)).toEqual(['old', 'new'])
  })

  test('does not move a row for agent activity', () => {
    // WHY: an agent's reply, a wake, or an automation's prompt must not move
    // rows under the pointer. Only the person's own sends reorder a folder.
    const [alpha] = buildProjectFolders({
      drafts: [],
      sessions: [
        row('quiet', 'alpha', { createdAt: 200 }),
        row('busy', 'alpha', { createdAt: 100, status: 'running', runStartedAt: 9_000, unread: true }),
      ],
      projects: [project('alpha')],
      isFolderOpen: () => true,
      sentAt: () => 0,
      shelfRevealTaskId: null,
    })
    expect(alpha.rows.map((task) => task.id)).toEqual(['quiet', 'busy'])
  })

  test('a closed folder shows its count, a dot for a hidden session that needs you, and the row on screen', () => {
    const sessions = [
      row('reading', 'alpha', { status: 'question' }),
      row('asks', 'alpha', { status: 'question' }),
      row('idle', 'alpha'),
    ]
    const closed = (shelfRevealTaskId: string | null, rows = sessions) =>
      buildProjectFolders({
        drafts: [],
        sessions: rows,
        projects: [project('alpha')],
        isFolderOpen: () => false,
        sentAt: () => 0,
        shelfRevealTaskId,
      })[0]
    const folder = closed('reading')
    expect(folder.folder).toMatchObject({ isOpen: false, count: 3, hasHiddenAttention: true })
    // The conversation you read never disappears into a folder.
    expect(folder.rows.map((task) => task.id)).toEqual(['reading'])
    // The row on screen is not hidden, so it raises no dot by itself.
    expect(closed('reading', [sessions[0], sessions[2]]).folder.hasHiddenAttention).toBe(false)
    // Unread output wants you as much as a question does.
    expect(closed(null, [row('done', 'alpha', { unread: true })]).folder.hasHiddenAttention).toBe(true)
  })

  test('a draft leads its project folder, and a project with only a draft still has one', () => {
    // WHY: the project view answers "what is going on in this project". A
    // prompt the person has written for a project is part of that answer, so
    // it files under the project rather than above every folder.
    const items = list({
      drafts: [draft('d-beta', 'beta'), draft('d-alpha', 'alpha')],
      sessions: [row('a1', 'alpha')],
      projects: [project('alpha'), project('beta')],
    })
    expect(items.map((item) => item.key)).toEqual([
      'folder:alpha',
      'draft:d-alpha',
      'a1:card',
      'folder:beta',
      'draft:d-beta',
    ])
    expect(items.find((item) => item.key === 'draft:d-alpha')).toMatchObject({ folderKey: 'alpha' })
    expect(items.find((item) => item.key === 'folder:beta')).toMatchObject({ folder: { count: 1, label: 'beta' } })
    expect(items.some((item) => item.kind === 'drafts-divider')).toBe(false)
  })

  test('a closed folder counts its drafts and hides them', () => {
    // WHY: a draft needs nobody, so a closed folder keeps it out of the way;
    // the count still says the folder holds it.
    const [folder] = buildProjectFolders({
      drafts: [draft('d1', 'alpha')],
      sessions: [row('a1', 'alpha')],
      projects: [project('alpha')],
      isFolderOpen: () => false,
      sentAt: () => 0,
      shelfRevealTaskId: null,
    })
    expect(folder.folder.count).toBe(2)
    expect(folder.drafts).toEqual([])
  })

  test('names a project the workspace does not know by its rows', () => {
    const [folder] = buildProjectFolders({
      drafts: [],
      sessions: [row('x1', 'repo-key', { projectLabel: 'scratch' })],
      projects: [],
      isFolderOpen: () => true,
      sentAt: () => 0,
      shelfRevealTaskId: null,
    })
    expect(folder.folder).toMatchObject({ key: 'repo-key', label: 'scratch', project: null })
  })
})

describe('project folders in the keyboard tree', () => {
  test('→ opens a closed folder, then moves into its sessions', () => {
    expect(treeKeyIntent('ArrowRight', { index: 2, parentIndex: null, folderOpen: false }, 5))
      .toEqual({ kind: 'setFolderOpen', isOpen: true })
    expect(treeKeyIntent('ArrowRight', { index: 2, parentIndex: null, folderOpen: true }, 5))
      .toEqual({ kind: 'focus', index: 3 })
  })

  test('← closes an open folder, and climbs from a session back to its folder', () => {
    expect(treeKeyIntent('ArrowLeft', { index: 2, parentIndex: null, folderOpen: true }, 5))
      .toEqual({ kind: 'setFolderOpen', isOpen: false })
    expect(treeKeyIntent('ArrowLeft', { index: 2, parentIndex: null, folderOpen: false }, 5)).toBeNull()
    expect(treeKeyIntent('ArrowLeft', { index: 3, parentIndex: 2 }, 5)).toEqual({ kind: 'focus', index: 2 })
  })

  test('⌫ on a folder does nothing, and the arrows walk past it', () => {
    // WHY: ⌫ archives a session. A project is not a row the list can archive.
    expect(treeKeyIntent('Backspace', { index: 2, parentIndex: null, folderOpen: true }, 5)).toBeNull()
    expect(treeKeyIntent('ArrowDown', { index: 2, parentIndex: null, folderOpen: false }, 5))
      .toEqual({ kind: 'focus', index: 3 })
  })
})

describe('rows that started sessions in the keyboard tree', () => {
  test('→ unfolds folded sessions, then enters the pane', () => {
    // WHY: a row with sessions folded under it opens like a folder does, so
    // the keys mean the same thing on every row that can open.
    expect(treeKeyIntent('ArrowRight', { index: 1, parentIndex: null, nestedOpen: false }, 4))
      .toEqual({ kind: 'setNestedOpen', isOpen: true })
    expect(treeKeyIntent('ArrowRight', { index: 1, parentIndex: null, nestedOpen: true }, 4))
      .toEqual({ kind: 'enterPane' })
  })

  test('← folds open sessions before it climbs to the folder', () => {
    expect(treeKeyIntent('ArrowLeft', { index: 2, parentIndex: 0, nestedOpen: true }, 4))
      .toEqual({ kind: 'setNestedOpen', isOpen: false })
    expect(treeKeyIntent('ArrowLeft', { index: 2, parentIndex: 0, nestedOpen: false }, 4))
      .toEqual({ kind: 'focus', index: 0 })
  })
})

describe('folder open state', () => {
  function memoryStorage() {
    const values = new Map<string, string>()
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
  }

  test('is kept per project across reloads', () => {
    const storage = memoryStorage()
    const first = new SidebarFolderState(storage)
    expect(first.isOpen('alpha')).toBe(true)
    first.toggle('alpha')
    const reloaded = new SidebarFolderState(storage)
    expect(reloaded.isOpen('alpha')).toBe(false)
    expect(reloaded.isOpen('beta')).toBe(true)
  })

  test('a damaged saved value opens every folder', () => {
    const storage = memoryStorage()
    storage.setItem(CLOSED_FOLDERS_STORAGE_KEY, '{"not":"a list"}')
    expect(new SidebarFolderState(storage).isOpen('alpha')).toBe(true)
  })
})
