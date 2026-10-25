import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { MemberFileChange } from '@solus/server/execution/seats/member-files'
import type { ProcessUser } from '@solus/server/cli-env'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const apply = mock((_user: ProcessUser | null, _changes: MemberFileChange[]) => {})
mock.module('@solus/server/execution/seats/member-files', () => ({ applyMemberFiles: apply }))
const { makeChatFolder } = await import('@solus/server/workspace')
const home = mkdtempSync(join(tmpdir(), 'solus-shared-chat-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

test('a managed chat permits other members to start sessions and keeps the project group on new files', () => {
  const folder = makeChatFolder(home, 'shared-chat', { uid: 20000 })
  expect(apply).toHaveBeenCalledWith({ uid: 20000 }, [
    { kind: 'folder', path: folder, mode: 0o2775 },
  ])
})
