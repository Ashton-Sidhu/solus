import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent } from '@solus/contracts/types'
import { git } from '@solus/server/git/exec'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
mock.module('@solus/server/git/worktree-name', () => ({ generateWorktreeName: async () => 'Fix Layout' }))

const previousDataDir = process.env.SOLUS_DATA_DIR
const directory = mkdtempSync(join(tmpdir(), 'solus-early-worktree-name-'))
let controlPlane: typeof import('@solus/server/control-plane')
let database: typeof import('@solus/server/db')
beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = join(directory, 'data')
  controlPlane = await import('@solus/server/control-plane')
  database = await import('@solus/server/db')
})
afterAll(() => {
  database.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(directory, { recursive: true, force: true })
})

test('naming before session registration updates the checkout retained by dispatch', async () => {
  const { createWorktree } = await import('@solus/server/git/worktree-manager')
  git(['init', '-b', 'main'], directory)
  git(['config', 'user.name', 'Test'], directory)
  git(['config', 'user.email', 'test@example.invalid'], directory)
  git(['commit', '--allow-empty', '-m', 'Initial'], directory)
  const checkout = await createWorktree(directory, 'main')
  const plane = new controlPlane.ControlPlane(new Map())
  const events: NormalizedEvent[] = []
  plane.on('event', (_sessionId: string, event: NormalizedEvent) => events.push(event))
  try {
    await plane.nameWorktreeBranch('pending-session', checkout, 'Fix layout')
    expect(checkout.branch).toBe('solus/fix-layout')
    expect(git(['branch', '--show-current'], checkout.worktreePath!)).toBe(checkout.branch)
    expect(events).toContainEqual({ type: 'git_context', gitContext: checkout })
  } finally {
    plane.shutdown()
  }
})
