import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { HostApi } from '@solus/client-core/host-api'
import type { DirectoryEntry, HostPathMutation, HostPathMutationResult } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
type EditsModule = typeof import('@solus/workspace-ui/components/pickers/lib/directory-edits.svelte')
let DirectoryEdits: EditsModule['DirectoryEdits']
let folderNameProblem: EditsModule['folderNameProblem']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ DirectoryEdits, folderNameProblem } = await import(
    '@solus/workspace-ui/components/pickers/lib/directory-edits.svelte'
  ))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const entry: DirectoryEntry = { name: 'old', isDir: true, path: '/work/old' }

function editsWith(answer: (mutation: HostPathMutation) => HostPathMutationResult) {
  const sent: HostPathMutation[] = []
  const changes: Array<string | null> = []
  const api = {
    mutateHostPath: async (mutation: HostPathMutation) => {
      sent.push(mutation)
      return answer(mutation)
    },
    createDirectory: async (path: string) => ({ path, error: null }),
  } as Pick<HostApi, 'mutateHostPath' | 'createDirectory'> as HostApi
  const edits = new DirectoryEdits({
    api: () => api,
    directory: () => '/work',
    platform: () => 'posix',
    siblingNames: () => ['old', 'notes.md'],
    onChanged: (landedPath) => void changes.push(landedPath),
  })
  return { edits, sent, changes }
}

describe('folder names in the picker', () => {
  test('rejects a name that is taken by a file or a folder', () => {
    // WHY: createDirectory is recursive and would silently "succeed" on an
    // existing folder; a rename onto a file would fail late on the host.
    expect(folderNameProblem('notes.md', ['old', 'notes.md'])).not.toBeNull()
    expect(folderNameProblem('old', ['old'])).not.toBeNull()
    expect(folderNameProblem('new', ['old'])).toBeNull()
  })

  test('a rename may keep its own name, and a name is one segment', () => {
    expect(folderNameProblem('old', ['old'], 'old')).toBeNull()
    expect(folderNameProblem('a/b', [])).not.toBeNull()
    expect(folderNameProblem('..', [])).not.toBeNull()
    expect(folderNameProblem('   ', [])).not.toBeNull()
  })
})

describe('removing a folder from the picker', () => {
  test('asks for the Trash first and deletes permanently only after a second confirm', async () => {
    // WHY: the picker reaches any folder on the host. Losing one for good must
    // take a separate, explicit choice after the host says it has no Trash.
    const { edits, sent, changes } = editsWith((mutation) =>
      mutation.op === 'trash'
        ? { ok: false, error: 'no trash', trashUnavailable: true }
        : { ok: true, path: '' },
    )
    edits.startTrash(entry)
    await edits.commit()
    expect(sent.map((mutation) => mutation.op)).toEqual(['trash'])
    expect(edits.edit).toEqual({ kind: 'delete', entry })
    expect(changes).toEqual([])

    await edits.commit()
    expect(sent.map((mutation) => mutation.op)).toEqual(['trash', 'delete'])
    expect(edits.edit).toBeNull()
    expect(changes).toEqual([null])
  })

  test('a failed rename keeps the edit open with the host error', async () => {
    const { edits, changes } = editsWith(() => ({ ok: false, error: 'Something with that name already exists here.' }))
    edits.startRename(entry)
    edits.setName('fresh')
    await edits.commit()
    expect(edits.edit?.kind).toBe('rename')
    expect(edits.error).toBe('Something with that name already exists here.')
    expect(changes).toEqual([])
  })

  test('a new folder lands in the browsed folder and is highlighted', async () => {
    const { edits, changes } = editsWith(() => ({ ok: true, path: '' }))
    edits.startCreate()
    edits.setName('fresh')
    await edits.commit()
    expect(changes).toEqual(['/work/fresh'])
  })
})
