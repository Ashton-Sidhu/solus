import { describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { IpcContext } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { workTreeForCtx } = await import('@solus/server/transport/handlers/worktree-handlers')

const contextFor = (session: Partial<IpcContext['session']>) => ({ session }) as IpcContext

describe('the checkout of a diff request', () => {
  test('is known without asking git, so a file load spawns nothing for it', () => {
    // WHY: a large diff loads each file with its own request. Reading the
    // branch for each one cost two spawns, and no caller used the branch.
    expect(workTreeForCtx(contextFor({ workingDirectory: '/no/such/checkout', gitContext: null }))).toBe('/no/such/checkout')
  })

  test('is the worktree the client names, not the folder the session started in', () => {
    // WHY: a session in a worktree must diff that worktree, not the project.
    const gitContext = { branch: 'fix', targetBranch: 'main', worktreePath: '/work/fix' }
    expect(workTreeForCtx(contextFor({ workingDirectory: '/work/project', gitContext }))).toBe('/work/fix')
  })
})
