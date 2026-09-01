import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { devServeRoots } from '../../scripts/vite-fs-allow'

describe('devServeRoots', () => {
  test('allows the parent checkout node_modules a worktree resolves through', () => {
    // WHY: a git worktree has no node_modules of its own, so every dependency
    // resolves to the primary checkout — outside Vite's default allow list.
    // Assets served over /@fs/ (the @pierre/diffs highlighter worker) then get
    // a 403 and the surfaces waiting on that worker render nothing.
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'solus-fs-allow-')))
    mkdirSync(join(checkout, 'node_modules'))
    const worktree = join(checkout, '.git', 'solus', 'worktrees', 'branch')
    mkdirSync(worktree, { recursive: true })

    expect(devServeRoots(worktree)).toEqual([worktree, join(checkout, 'node_modules')])
  })

  test('does not widen the allow list for an ordinary checkout', () => {
    // WHY: the project root already covers its own node_modules. Adding roots
    // that are not needed hands the dev server reach it should not have.
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'solus-fs-allow-')))
    mkdirSync(join(checkout, 'node_modules'))

    expect(devServeRoots(checkout)).toEqual([checkout])
  })
})
