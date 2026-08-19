import { describe, expect, test } from 'bun:test'
import { projectScopeOf } from '@solus/contracts/types'

/**
 * `projectScopeOf` is the key that task `targetScope`, the `projectRoot` on PR
 * events, and the renderer's per-project caches are all built from. Producers
 * live in the main process and consumers in the renderer, and they compare the
 * results for equality — `ActivityFeed` drops an event whose `projectRoot`
 * doesn't match. So the operator matters: `??` and `||` disagree exactly when a
 * session has no project, and a split there means a live PR surface silently
 * stops updating.
 */
describe('projectScopeOf', () => {
  test('prefers the opened project', () => {
    expect(projectScopeOf({ projectPath: '/repo', workingDirectory: '/repo/.solus-worktrees/fix' }))
      .toBe('/repo')
  })

  test('falls through an empty project path to the working directory', () => {
    // The `??` spellings this replaced returned '' here, so a renderer cache key
    // and a main-process event root disagreed for any session with no project.
    expect(projectScopeOf({ projectPath: '', workingDirectory: '/tmp/scratch' }))
      .toBe('/tmp/scratch')
  })

  test('reports the placeholder rather than inventing a directory', () => {
    // '~' means "no folder open". Callers that touch the filesystem check for
    // it; resolving it to $HOME here would let them write to the wrong place.
    expect(projectScopeOf({ projectPath: '', workingDirectory: '~' })).toBe('~')
  })
})
