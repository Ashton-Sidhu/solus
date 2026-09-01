import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveHomePath } from '../../packages/server/src/platform/paths'

/**
 * The renderer sends `'~'` when no working directory is known yet — a fresh
 * open with no tabs reaches it through `globalDefaults.workingDirectory`.
 * `spawn` reads that as a literal directory, fails with ENOENT, and the Claude
 * SDK reports the ENOENT as "the native binary exists but failed to launch",
 * naming the executable for a fault in its working directory. Every agent path
 * is resolved before it reaches a process.
 */
describe('resolveHomePath', () => {
  test('expands the sentinel the renderer sends when no directory is known', () => {
    expect(resolveHomePath('~')).toBe(homedir())
  })

  test('expands a tilde-rooted path', () => {
    expect(resolveHomePath('~/projects/solus')).toBe(join(homedir(), 'projects/solus'))
    expect(resolveHomePath('~/')).toBe(homedir())
  })

  test('treats an empty directory as unknown rather than passing it to spawn', () => {
    expect(resolveHomePath('')).toBe(homedir())
  })

  test('leaves a real path alone', () => {
    expect(resolveHomePath('/Users/someone/code')).toBe('/Users/someone/code')
  })

  test('only expands a leading tilde — one inside a path is a real directory name', () => {
    expect(resolveHomePath('/tmp/~backup')).toBe('/tmp/~backup')
    expect(resolveHomePath('/tmp/~/nested')).toBe('/tmp/~/nested')
  })
})

/**
 * A run that fails before `session_init` has no agentSessionId, so the
 * ControlPlane can only find its session through the backend's pending handles.
 * `finishRun` empties those, so emitting after it delivered the error to no
 * session at all: the record was left for the run watchdog, which reported it
 * as a dead session with no exit code and the real reason lost.
 */
describe('a failed run reports before it stops being tracked', () => {
  const backends = [
    'packages/server/src/agents/claude/claude-backend.ts',
    'packages/server/src/agents/codex/codex-backend.ts',
  ]

  for (const backend of backends) {
    test(`${backend} emits the error before finishRun in every catch`, () => {
      const source = readFileSync(backend, 'utf8')
      const catches = source.split(/\bcatch\b/).slice(1)
      const reporting = catches.filter((body) => {
        const scope = body.slice(0, body.indexOf('\n  }'))
        return scope.includes("this.emit('error'") && scope.includes('this.finishRun(')
      })
      expect(reporting.length).toBeGreaterThan(0)
      for (const body of reporting) {
        expect(body.indexOf("this.emit('error'")).toBeLessThan(body.indexOf('this.finishRun('))
      }
    })
  }
})

/**
 * The reducer writes the dead-session notice as prose and the transcript
 * recognises it by pattern, so the two drift silently. A turn that stops being
 * recognised loses its failure card.
 */
test('the transcript recognises the notice the reducer writes for a dead session', () => {
  const reducer = readFileSync(
    'packages/workspace-ui/src/contexts/workspace/session-event-reducer.svelte.ts',
    'utf8',
  )
  const turns = readFileSync('packages/workspace-ui/src/components/conversation/lib/turns.ts', 'utf8')

  const deadPattern = turns.match(/const DEAD_RE = (\/.+\/)\n/)
  expect(deadPattern).not.toBeNull()
  const [source, flags] = [deadPattern![1].slice(1, -1), '']
  const matcher = new RegExp(source, flags)

  const notices = [...reducer.matchAll(/'(Session [^']+)'/g)].map((m) => m[1])
  expect(notices.length).toBeGreaterThan(0)
  for (const notice of notices) expect(matcher.test(notice)).toBe(true)

  // The watchdog has no exit code, so the notice it writes must not invent one.
  expect(notices.some((notice) => notice.includes('exit null'))).toBe(false)
})
