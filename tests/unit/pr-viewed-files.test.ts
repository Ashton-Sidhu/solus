import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { PrViewedFileChange, PrViewedFiles as HostViewedFiles } from '@solus/contracts/providers'

// GitHub's own "Viewed" marks are the only record when the host keeps them.
// A toggle must show at once, reach the host in one batch, and go back to what
// it was when the host refuses — without undoing a newer toggle or letting a
// read that crossed the write put the old mark back.

interface RuneGlobals {
  $state?: unknown
}
const previousState = (globalThis as unknown as RuneGlobals).$state

beforeEach(() => {
  ;(globalThis as unknown as RuneGlobals).$state = <T>(value: T) => value
})

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as RuneGlobals).$state
  else (globalThis as unknown as RuneGlobals).$state = previousState
})

interface Host {
  answer: HostViewedFiles
  writes: PrViewedFileChange[][]
  failWrites: boolean
}

async function viewedFiles(host: Host) {
  const { PrViewedFiles } = await import('@solus/workspace-ui/contexts/prs/pr-viewed-files.svelte')
  return new PrViewedFiles({
    read: async () => structuredClone(host.answer),
    write: async (changes) => {
      host.writes.push(changes)
      if (host.failWrites) throw new Error('GitHub refused the change.')
    },
    // Tests flush by hand.
    debounceMs: 60_000,
  })
}

function hostWith(files: HostViewedFiles['files'], complete = true): Host {
  return { answer: { files, complete }, writes: [], failWrites: false }
}

describe('viewed files', () => {
  test('reads the marks, and a changed-since-viewed file reads as dismissed', async () => {
    const host = hostWith([
      { path: 'a.ts', state: 'viewed' },
      { path: 'b.ts', state: 'dismissed' },
    ])
    const marks = await viewedFiles(host)
    await marks.load()
    expect(marks.stateFor('a.ts')).toBe('viewed')
    expect(marks.stateFor('b.ts')).toBe('dismissed')
    expect(marks.stateFor('c.ts')).toBe('unviewed')
    expect(marks.viewedCount(['a.ts', 'b.ts', 'c.ts'])).toBe(1)
  })

  test('an incomplete answer does not claim an unlisted file is unviewed', async () => {
    const marks = await viewedFiles(hostWith([{ path: 'a.ts', state: 'viewed' }], false))
    await marks.load()
    expect(marks.stateFor('z.ts')).toBe('unknown')
  })

  test('toggles show at once and reach the host as one batch, the last toggle of a path winning', async () => {
    const host = hostWith([{ path: 'b.ts', state: 'dismissed' }])
    const marks = await viewedFiles(host)
    await marks.load()
    marks.toggle('a.ts')
    marks.toggle('b.ts')
    marks.toggle('c.ts')
    marks.toggle('c.ts')
    expect(marks.stateFor('a.ts')).toBe('viewed')
    // Toggling a file that changed since it was viewed marks it viewed again.
    expect(marks.stateFor('b.ts')).toBe('viewed')
    expect(host.writes).toHaveLength(0)
    await marks.flush()
    expect(host.writes).toEqual([[
      { path: 'a.ts', viewed: true },
      { path: 'b.ts', viewed: true },
      { path: 'c.ts', viewed: false },
    ]])
  })

  test('a refused write puts every mark back the way it was and says why until a write succeeds', async () => {
    const host = hostWith([{ path: 'b.ts', state: 'dismissed' }])
    const marks = await viewedFiles(host)
    await marks.load()
    host.failWrites = true
    marks.toggle('a.ts')
    marks.toggle('b.ts')
    await marks.flush()
    expect(marks.stateFor('a.ts')).toBe('unviewed')
    expect(marks.stateFor('b.ts')).toBe('dismissed')
    expect(marks.writeError).toBe('GitHub refused the change.')
    host.failWrites = false
    marks.toggle('a.ts')
    await marks.flush()
    expect(marks.writeError).toBeNull()
  })

  test('a refusal does not undo a newer toggle of the same file', async () => {
    const host = hostWith([])
    const marks = await viewedFiles(host)
    await marks.load()
    host.failWrites = true
    marks.toggle('a.ts')
    const write = marks.flush()
    // The reader takes the mark back while the first write is on the wire.
    marks.toggle('a.ts')
    await write
    expect(marks.stateFor('a.ts')).toBe('unviewed')
    host.failWrites = false
    await marks.flush()
    expect(host.writes.at(-1)).toEqual([{ path: 'a.ts', viewed: false }])
  })

  test('a read that crosses an unanswered write keeps the toggle', async () => {
    const host = hostWith([])
    const marks = await viewedFiles(host)
    await marks.load()
    marks.toggle('a.ts')
    // The host still says unviewed: the write has not been sent.
    await marks.load()
    expect(marks.stateFor('a.ts')).toBe('viewed')
  })
})
