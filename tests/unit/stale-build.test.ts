import { afterAll, describe, expect, test } from 'bun:test'

// The module imports the toast service, whose svelte-sonner dependency runs
// runes at module scope. Same stub the other renderer-lib tests use.
const previousState = (globalThis as unknown as { $state?: unknown }).$state
;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const { isStaleBuildError } = await import('../../client/src/lib/stale-build')

describe('stale build detection', () => {
  test('recognises the module-load failures a rebuilt host produces', () => {
    // Safari, when the SPA shell answers a request for a deleted chunk.
    expect(isStaleBuildError(new TypeError("'text/html' is not a valid JavaScript MIME type."))).toBe(true)
    // Chrome and Firefox, once the host 404s that chunk instead.
    expect(isStaleBuildError(new TypeError('Failed to fetch dynamically imported module: /assets/tasks-a1b2c3.js'))).toBe(true)
    expect(isStaleBuildError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isStaleBuildError(new TypeError('Importing a module script failed.'))).toBe(true)
  })

  test('leaves ordinary failures to their own reporting', () => {
    // A host that is simply unreachable is a connection state, not a stale
    // tab: reporting it as "reload for the new build" would be a lying label.
    expect(isStaleBuildError(new Error('Failed to fetch'))).toBe(false)
    expect(isStaleBuildError(new Error('Unknown Solus server: studio'))).toBe(false)
    expect(isStaleBuildError(new TypeError('tasks is not a function'))).toBe(false)
  })
})
