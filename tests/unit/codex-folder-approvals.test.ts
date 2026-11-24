import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { CodexAppServerClient } from '@solus/server/execution/agents/codex/codex-agent'
import type { NormalizedEvent, PermissionMode } from '@solus/contracts/types'
import type { SessionFolderGate } from '@solus/server/execution/agents/session-folder-gate'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
let approvalPaths: typeof import('@solus/server/execution/agents/codex/codex-permissions')['approvalPaths']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
  ;({ approvalPaths } = await import('@solus/server/execution/agents/codex/codex-permissions'))
})

// docs/plans/codebases.md §6: Codex gets its writable roots at a turn start.
// A folder that the session got in the middle of a turn is not one of them, so
// Codex asks before each write there. The person already allowed the folder,
// so the modes that ask nothing for a write in a writable root accept it.

const FILE_CHANGE = 'item/fileChange/requestApproval'
const PERMISSIONS = 'item/permissions/requestApproval'

describe('the paths that an approval request names', () => {
  test('a patch names each file it changes, and the root it asks for', () => {
    const changes = [{ path: '/work/libs/ui/a.ts', kind: { type: 'update' }, diff: '' }, { path: 'src/b.ts', kind: { type: 'add' }, diff: '' }]
    expect(approvalPaths(FILE_CHANGE, { itemId: 'item-1', grantRoot: '/work/libs' }, changes, '/work/shop/api'))
      .toEqual(['/work/libs', '/work/libs/ui/a.ts', '/work/shop/api/src/b.ts'])
  })

  test('a permissions request names the folders it wants', () => {
    expect(approvalPaths(PERMISSIONS, { permissions: { network: null, fileSystem: { read: ['/work/docs'], write: ['/work/libs/ui'] } } }, undefined, '/work'))
      .toEqual(['/work/docs', '/work/libs/ui'])
  })

  test('a request that does not name its paths gives null', () => {
    // A command names no file. A patch whose changes Solus did not get names none.
    expect(approvalPaths('item/commandExecution/requestApproval', { command: 'rm -rf build', cwd: '/work/libs/ui' }, undefined, '/work')).toBeNull()
    expect(approvalPaths(FILE_CHANGE, { itemId: 'item-1' }, undefined, '/work')).toBeNull()
    // A request that also wants the network is not only about folders.
    expect(approvalPaths(PERMISSIONS, { permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['/work/libs/ui'] } } }, undefined, '/work')).toBeNull()
    // Entries have a shape that Solus does not read.
    expect(approvalPaths(PERMISSIONS, { permissions: { network: null, fileSystem: { read: null, write: null, entries: [{ path: { type: 'absolute' }, access: 'write' }] } } }, undefined, '/work')).toBeNull()
  })
})

interface Gate extends SessionFolderGate {
  allowed: { sessionId: string; paths: string[] }[]
}

function gate(granted: string[]): Gate {
  const allowed: Gate['allowed'] = []
  return {
    allowed,
    modeOf: () => undefined,
    grantedFolderOf: (_sessionId, path) => granted.find((folder) => path === folder || path.startsWith(`${folder}/`)) ?? null,
    attachUnasked: async () => null,
    attachAllowed: (sessionId, paths) => { allowed.push({ sessionId, paths: [...paths] }) },
    checkpointTargets: () => [],
  }
}

/** A Codex run in `mode` whose Solus session has the granted folders of `folders`. */
function backendWithRun(mode: PermissionMode, folders: Gate) {
  const backend = new CodexBackend()
  backend.useSessionFolders(folders)
  const responses: unknown[] = []
  const client = new CodexAppServerClient({})
  client.respond = (_id, result) => { responses.push(result) }
  Reflect.apply(Reflect.get(backend, 'attachClient') as (client: CodexAppServerClient) => void, backend, [client])
  const activeRuns = Reflect.get(backend, 'activeRuns') as Map<string, { client: CodexAppServerClient; permissionMode: PermissionMode; sawPermissionRequest: boolean; sessionId: string; cwd: string }>
  activeRuns.set('thread-1', { client, permissionMode: mode, sawPermissionRequest: false, sessionId: 'session-1', cwd: '/work/shop/api' })
  const cards: Extract<NormalizedEvent, { type: 'permission_request' }>[] = []
  backend.on('normalized', (_threadId: string, event: NormalizedEvent) => {
    if (event.type === 'permission_request') cards.push(event)
  })
  let nextId = 1
  const fileChangesByItem = Reflect.get(backend, 'fileChangesByItem') as Map<string, unknown[]>
  /** Codex started a patch item with its changes (kept by item id), and now asks to apply it. */
  const askPatch = (paths: string[]): void => {
    const itemId = `item-${nextId}`
    fileChangesByItem.set(itemId, paths.map((path) => ({ path, kind: { type: 'update' }, diff: '' })))
    client.emit('server-request', { jsonrpc: '2.0', id: nextId++, method: FILE_CHANGE, params: { threadId: 'thread-1', turnId: 'turn-1', itemId } })
  }
  const askCommand = (): void => {
    client.emit('server-request', { jsonrpc: '2.0', id: nextId++, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: `item-${nextId}`, command: 'touch /work/libs/ui/a.ts', cwd: '/work/libs/ui' } })
  }
  return { backend, responses, cards, askPatch, askCommand }
}

describe('a Codex approval for a write in a session folder', () => {
  for (const mode of ['accept-edits', 'auto'] as const) {
    test(`${mode}: a patch whose files are all in granted folders is accepted with no card`, () => {
      const { responses, cards, askPatch } = backendWithRun(mode, gate(['/work/libs/ui', '/work/tools/cli']))
      askPatch(['/work/libs/ui/src/a.ts', '/work/tools/cli/main.ts'])
      expect(responses).toEqual(['accept'])
      expect(cards).toEqual([])
    })
  }

  test('a patch with one file outside the granted folders keeps its card', () => {
    const { responses, cards, askPatch } = backendWithRun('accept-edits', gate(['/work/libs/ui']))
    askPatch(['/work/libs/ui/src/a.ts', '/work/elsewhere/b.ts'])
    expect(responses).toEqual([])
    expect(cards).toHaveLength(1)
  })

  test('a command names no path, so it keeps its card', () => {
    const { responses, cards, askCommand } = backendWithRun('accept-edits', gate(['/work/libs/ui']))
    askCommand()
    expect(responses).toEqual([])
    expect(cards).toHaveLength(1)
  })

  test('supervised keeps the card: that mode asks for each write, also in the working directory', () => {
    const { responses, cards, askPatch } = backendWithRun('supervised', gate(['/work/libs/ui']))
    askPatch(['/work/libs/ui/src/a.ts'])
    expect(responses).toEqual([])
    expect(cards).toHaveLength(1)
  })

  test('"Allow for session" on a request that names its paths attaches their folders; "Allow" does not', () => {
    const folders = gate([])
    const { backend, responses, cards, askPatch, askCommand } = backendWithRun('supervised', folders)

    askPatch(['/work/tools/cli/main.ts'])
    backend.permissions.respondToPermission(cards[0]!.questionId, 'accept')
    expect(folders.allowed).toEqual([])

    askPatch(['/work/tools/cli/main.ts', '/work/tools/cli/lib.ts'])
    backend.permissions.respondToPermission(cards[1]!.questionId, 'acceptForSession')
    expect(responses).toEqual(['accept', 'acceptForSession'])
    // The Solus session id, not the thread id of Codex, names the session.
    expect(folders.allowed).toEqual([{ sessionId: 'session-1', paths: ['/work/tools/cli/main.ts', '/work/tools/cli/lib.ts'] }])

    // A command names no path: its approval for the session attaches nothing.
    askCommand()
    backend.permissions.respondToPermission(cards[2]!.questionId, 'acceptForSession')
    expect(folders.allowed).toHaveLength(1)
  })
})
