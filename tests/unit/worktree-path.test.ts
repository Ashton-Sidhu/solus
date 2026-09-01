import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { isSolusWorktreePath, worktreeProjectRoot } from '@solus/contracts/types'
import { worktreePathFor } from '@solus/server/git/worktree-path'

describe('managed worktree paths', () => {
  test('a worktree resolves to the project root that owns it', () => {
    // WHY: worktrees live in the git directory so no project needs a .gitignore
    // entry for them. The project root staying a literal prefix is what keeps
    // this derivation a pure string operation.
    const worktree = '/repos/atlas/.git/solus/worktrees/solus-fix-login-a1b2c'
    expect(isSolusWorktreePath(worktree)).toBe(true)
    expect(worktreeProjectRoot(worktree)).toBe('/repos/atlas')
  })

  test('resolves a worktree that no longer exists on disk', () => {
    // WHY: the session indexer resolves this per indexed session from provider
    // JSONL cwd strings, and those worktrees are routinely already deleted.
    // Nothing here may consult git or the filesystem.
    const deleted = '/repos/atlas/.git/solus/worktrees/deleted-branch/src/main.ts'
    expect(worktreeProjectRoot(deleted)).toBe('/repos/atlas')
  })

  test('the pre-relocation layout is no longer recognized', () => {
    // WHY: this is the deliberate break. Worktrees left at the old in-repo
    // location are treated as ordinary directories, and nothing should quietly
    // reintroduce the marker to "fix" them.
    const legacy = '/repos/atlas/.solus-worktrees/solus-fix-login-a1b2c'
    expect(isSolusWorktreePath(legacy)).toBe(false)
    expect(worktreeProjectRoot(legacy)).toBe(legacy)
  })

  test('Solus\'s other state in the git directory is not a worktree', () => {
    // WHY: session snapshots already own `.git/solus/`. Classifying a sidecar or
    // a temp index as a checkout would scope its session to a bogus project.
    expect(isSolusWorktreePath('/repos/atlas/.git/solus/sessions/abc.json')).toBe(false)
    expect(isSolusWorktreePath('/repos/atlas/.git/solus/tmp-index-9f2c')).toBe(false)
  })

  test('places a worktree inside the project git directory', () => {
    const repo = mkdtempSync(join(tmpdir(), 'solus-worktree-path-'))
    mkdirSync(join(repo, '.git'))

    expect(worktreePathFor(repo, 'pr-47')).toBe(join(repo, '.git', 'solus', 'worktrees', 'pr-47'))
  })

  test('refuses a checkout whose .git is a file rather than a directory', () => {
    // WHY: a linked worktree and a submodule both record `.git` as a gitfile.
    // Building a path through one would fail deep inside `git worktree add`;
    // callers must resolve the main repository root first.
    const linked = mkdtempSync(join(tmpdir(), 'solus-worktree-path-'))
    writeFileSync(join(linked, '.git'), 'gitdir: /repos/atlas/.git/worktrees/feature\n')

    expect(() => worktreePathFor(linked, 'pr-47')).toThrow('is not a directory')
  })
})
