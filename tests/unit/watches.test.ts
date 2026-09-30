import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Watch, WatchProbeResult } from '@solus/contracts/watch-types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const directory = mkdtempSync(join(tmpdir(), 'solus-watches-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = directory

let store: typeof import('@solus/server/watches/watches-store')
let service: typeof import('@solus/server/watches/watch-service')
let tools: typeof import('@solus/server/watches/watch-tools')
let probe: typeof import('@solus/server/watches/watch-probe')
let db: typeof import('@solus/server/db')

beforeAll(async () => {
  store = await import('@solus/server/watches/watches-store')
  service = await import('@solus/server/watches/watch-service')
  tools = await import('@solus/server/watches/watch-tools')
  probe = await import('@solus/server/watches/watch-probe')
  db = await import('@solus/server/db')
})
// Every test starts with no watch due but its own.
beforeEach(() => {
  for (const watch of store.listWatchesWithStatus(['waiting', 'paused', 'woken'])) store.cancelWatch(watch.id, 'user')
})
afterAll(() => {
  db.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(directory, { recursive: true, force: true })
})

const T0 = new Date('2026-09-24T12:00:00.000Z')

function result(exitCode: number | null, outputTail: string, error?: string): WatchProbeResult {
  return { exitCode, outputTail, at: T0.toISOString(), ...(error ? { error } : {}) }
}

/** A saved watch built through the same path the agent tool uses. */
function createWatch(sessionId: string, input: Parameters<typeof tools.watchFromInput>[0]): Watch {
  const built = tools.watchFromInput(input, sessionId, directory, T0)
  if (!built.ok) throw new Error(built.error)
  return store.saveWatch(built.value)
}

/** Resolves on the next save of `watchId` that satisfies `predicate`. Waiting
 *  on the store's own event keeps the tests free of sleeps. */
function nextSave(watchId: string, predicate: (watch: Watch) => boolean): Promise<Watch> {
  return new Promise((resolve) => {
    const stop = store.onWatchesChanged(({ watch }) => {
      if (watch.id !== watchId || !predicate(watch)) return
      stop()
      resolve(watch)
    })
  })
}

/** A service whose probe answers from a script and whose wakes are recorded.
 *  Each wake's turn ends when the test calls the returned `endTurn`. */
function harness(results: WatchProbeResult[]) {
  const wakes: Array<{ prompt: string; displayPrompt: string; watchId: string; endTurn: () => void }> = []
  let now = T0
  const watchService = new service.WatchService({
    now: () => now,
    runProbe: async () => {
      const next = results.shift()
      if (!next) throw new Error('The probe script ran out of results')
      return next
    },
    dispatchWake: async (wake) => {
      let endTurn!: () => void
      const done = new Promise<void>((resolve) => { endTurn = resolve })
      wakes.push({ ...wake, endTurn })
      return { done }
    },
  })
  return {
    watchService,
    wakes,
    advance(seconds: number) { now = new Date(now.getTime() + seconds * 1000) },
  }
}

describe('watch input', () => {
  test('a probe needs a condition, and a condition needs a probe', () => {
    expect(tools.watchFromInput({ reason: 'CI', probe_command: 'gh pr checks', every_seconds: 60 }, 's', directory).ok).toBe(false)
    expect(tools.watchFromInput({ reason: 'CI', until_exit_codes: [0], every_seconds: 60 }, 's', directory).ok).toBe(false)
  })

  test('refuses intervals under the floor, one-time probes, and repeating notices', () => {
    expect(tools.watchFromInput({ reason: 'x', probe_command: 'true', until_exit_codes: [0], every_seconds: 5 }, 's', directory).ok).toBe(false)
    expect(tools.watchFromInput({ reason: 'x', probe_command: 'true', until_exit_codes: [0], at: T0.toISOString() }, 's', directory).ok).toBe(false)
    expect(tools.watchFromInput({ reason: 'x', probe_command: 'true', until_exit_codes: [0], every_seconds: 60, on_match: 'notify', repeat: true }, 's', directory).ok).toBe(false)
    expect(tools.watchFromInput({ reason: 'x', probe_command: 'true', until_output_matches: '(', every_seconds: 60 }, 's', directory).ok).toBe(false)
  })

  test('a probe runs at once; a timer waits for its instant', () => {
    const probed = tools.watchFromInput({ reason: 'x', probe_command: 'true', until_exit_codes: [0], every_seconds: 60 }, 's', directory, T0)
    const timer = tools.watchFromInput({ reason: 'x', at: '2026-09-24T12:30:00.000Z' }, 's', directory, T0)
    expect(probed.ok && probed.value.nextRunAt).toBe(T0.toISOString())
    expect(timer.ok && timer.value.nextRunAt).toBe('2026-09-24T12:30:00.000Z')
  })
})

describe('watch service', () => {
  test('polls without waking until the condition matches, then wakes with the result', async () => {
    const { watchService, wakes, advance } = harness([result(8, 'pending'), result(1, 'lint failed')])
    const watch = createWatch('session-ci', { reason: 'Fix CI', probe_command: 'gh pr checks 42', until_exit_codes: [0, 1], every_seconds: 60 })

    await watchService.tick()
    expect(wakes).toHaveLength(0)
    expect(store.loadWatch(watch.id)?.nextRunAt).toBe(new Date(T0.getTime() + 60_000).toISOString())

    advance(60)
    await watchService.tick()
    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.prompt).toContain('lint failed')
    expect(wakes[0]!.prompt).toContain('Exit code: 1')
    expect(wakes[0]!.prompt).toContain('wake 1 of 5')
    expect(store.loadWatch(watch.id)?.status).toBe('woken')

    // A watch that does not repeat ends with its turn.
    const ended = nextSave(watch.id, (saved) => saved.status === 'done')
    wakes[0]!.endTurn()
    expect((await ended).endReason).toBe('The condition was met.')
  })

  test('a repeat watch re-arms after the turn, ignores the same result, wakes for a new one, and stops at its budget', async () => {
    const { watchService, wakes, advance } = harness([
      result(1, 'test A failed'),
      result(1, 'test A failed'),
      result(1, 'test B failed'),
    ])
    const watch = createWatch('session-repeat', {
      reason: 'Fix CI', probe_command: 'gh pr checks 7', until_exit_codes: [0, 1], every_seconds: 60, repeat: true, max_wakes: 2,
    })

    await watchService.tick()
    const rearmed = nextSave(watch.id, (saved) => saved.status === 'waiting')
    wakes[0]!.endTurn()
    await rearmed

    advance(60)
    await watchService.tick()
    expect(wakes).toHaveLength(1)

    advance(60)
    await watchService.tick()
    expect(wakes).toHaveLength(2)
    expect(wakes[1]!.prompt).toContain('The watch has ended: Used all 2 wakes.')
    const exhausted = nextSave(watch.id, (saved) => saved.status === 'exhausted')
    wakes[1]!.endTurn()
    await exhausted
  })

  test('three probe errors in a row end the watch and wake the session once with the error', async () => {
    const { watchService, wakes, advance } = harness([
      result(127, 'gh: command not found'),
      result(null, '', 'Timed out after 60s'),
      result(127, 'gh: command not found'),
    ])
    const watch = createWatch('session-errors', { reason: 'Fix CI', probe_command: 'gh pr checks', until_exit_codes: [0, 1], every_seconds: 60, repeat: true })
    for (let run = 0; run < 3; run++) {
      await watchService.tick()
      advance(60)
    }
    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.prompt).toContain('The watch has ended: The probe failed 3 times in a row.')
    const failed = nextSave(watch.id, (saved) => saved.status === 'failed')
    wakes[0]!.endTurn()
    await failed
  })

  test('a notify watch ends when the condition is met and never wakes the agent', async () => {
    const { watchService, wakes } = harness([result(0, 'healthy v1.4.2')])
    const watch = createWatch('session-notify', { reason: 'Deploy healthy', probe_command: 'curl health', until_output_matches: 'v1\\.4\\.2', every_seconds: 30, on_match: 'notify' })
    await watchService.tick()
    expect(wakes).toHaveLength(0)
    expect(store.loadWatch(watch.id)?.status).toBe('done')
  })

  test('a cancel during the woken turn stays cancelled when the turn ends', async () => {
    const { watchService, wakes } = harness([result(1, 'failed')])
    const watch = createWatch('session-cancel', { reason: 'Fix CI', probe_command: 'x', until_exit_codes: [1], every_seconds: 60, repeat: true })
    await watchService.tick()
    expect(store.cancelWatch(watch.id, 'user')?.status).toBe('cancelled')
    wakes[0]!.endTurn()
    await Promise.resolve()
    await Promise.resolve()
    expect(store.loadWatch(watch.id)?.status).toBe('cancelled')
  })

  test('a watch the previous process left woken is settled when the service starts', () => {
    const repeating = createWatch('session-restart', { reason: 'Fix CI', probe_command: 'x', until_exit_codes: [1], every_seconds: 60, repeat: true })
    const once = createWatch('session-restart', { reason: 'Check in', at: T0.toISOString() })
    store.saveWatch({ ...repeating, status: 'woken', wakeCount: 1 })
    store.saveWatch({ ...once, status: 'woken', wakeCount: 1 })
    const { watchService } = harness([])
    watchService.start()
    watchService.stop()
    expect(store.loadWatch(repeating.id)?.status).toBe('waiting')
    expect(store.loadWatch(once.id)?.status).toBe('done')
  })

  test('a timer wakes at its instant with the reason alone', async () => {
    const { watchService, wakes, advance } = harness([])
    const watch = createWatch('session-timer', { reason: 'Check the deploy again', at: new Date(T0.getTime() + 1_800_000).toISOString() })
    await watchService.tick()
    expect(wakes).toHaveLength(0)
    advance(1_800)
    await watchService.tick()
    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.displayPrompt).toBe('Check the deploy again')
    expect(store.loadWatch(watch.id)?.status).toBe('woken')
  })

  test('a session that cannot be woken fails the watch with the reason', async () => {
    const watchService = new service.WatchService({
      now: () => T0,
      runProbe: async () => result(0, 'done'),
      dispatchWake: async () => { throw new Error('Session gone not found') },
    })
    const watch = createWatch('session-missing', { reason: 'Job done', probe_command: 'x', until_exit_codes: [0], every_seconds: 60 })
    await watchService.tick()
    const failed = store.loadWatch(watch.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.endReason).toContain('Session gone not found')
  })

  test('a paused watch does not run; a resumed one runs at once', async () => {
    const { watchService, wakes } = harness([result(0, 'ok')])
    const watch = createWatch('session-pause', { reason: 'Job done', probe_command: 'x', until_exit_codes: [0], every_seconds: 60 })
    store.pauseWatch(watch.id)
    await watchService.tick()
    expect(wakes).toHaveLength(0)
    store.resumeWatch(watch.id, T0)
    await watchService.tick()
    expect(wakes).toHaveLength(1)
  })

  test('a watch past its expiry ends without a probe', async () => {
    const { watchService, advance } = harness([])
    const watch = createWatch('session-expire', { reason: 'Job done', probe_command: 'x', until_exit_codes: [0], every_seconds: 60, expires_in_hours: 1 })
    advance(3_600)
    await watchService.tick()
    expect(store.loadWatch(watch.id)?.status).toBe('expired')
  })
})

describe('probe runner', () => {
  test('returns the exit code and the output tail of a real command', async () => {
    const ran = await probe.runProbe({ command: 'printf "line one\\nline two"; exit 3', timeoutSeconds: 10 }, directory)
    expect(ran.exitCode).toBe(3)
    expect(ran.outputTail).toBe('line one\nline two')
    expect(ran.error).toBeUndefined()
  })

  test('a probe that outlives its timeout is stopped and reported as an error', async () => {
    const ran = await probe.runProbe({ command: 'sleep 30', timeoutSeconds: 1 }, directory)
    expect(ran.exitCode).toBeNull()
    expect(ran.error).toBe('Timed out after 1s')
  })
})
