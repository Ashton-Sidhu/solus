import { afterEach, expect, spyOn, test } from 'bun:test'
import { TaskOpenTrace } from '../../packages/workspace-ui/src/components/session/lib/task-open-timing'
import type { TaskOpenTiming } from '@solus/contracts/task-types'

const originalFrame = globalThis.requestAnimationFrame
const frames: FrameRequestCallback[] = []
const spies: ReturnType<typeof spyOn>[] = []
afterEach(() => {
  globalThis.requestAnimationFrame = originalFrame
  frames.length = 0
  for (const spy of spies.splice(0)) spy.mockRestore()
})

async function flushFrame() {
  for (const callback of frames.splice(0)) callback(0)
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('one report distinguishes host wait from the destination frame without delaying navigation', async () => {
  let now = 100
  spies.push(spyOn(performance, 'now').mockImplementation(() => now))
  spies.push(spyOn(console, 'info').mockImplementation(() => {}))
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
  const reports: TaskOpenTiming[] = []
  const trace = new TaskOpenTrace('task-a', async (report) => { reports.push(report) })
  now = 132
  trace.mark('navigation_started')
  now = 432
  trace.mark('owner_lookup_finished')
  trace.shown()
  trace.shown() // A resume can announce its destination more than once.
  await flushFrame()
  now = 448
  await flushFrame()
  now = 464
  await flushFrame()
  expect(reports).toHaveLength(0)
  now = 700
  const finished = trace.finish('completed')
  await flushFrame()
  await flushFrame()
  await flushFrame()
  await finished
  expect(reports).toHaveLength(1)
  expect(reports[0].marks).toEqual([
    { stage: 'activated', elapsedMs: 0 },
    { stage: 'navigation_started', elapsedMs: 32 },
    { stage: 'owner_lookup_finished', elapsedMs: 332 },
    { stage: 'destination_selected', elapsedMs: 332 },
    { stage: 'destination_frame', elapsedMs: 364 },
    { stage: 'navigation_completed', elapsedMs: 600 },
    { stage: 'settled_frame', elapsedMs: 600 },
  ])
})

test('an unavailable timing RPC does not reject navigation or omit the console report', async () => {
  const consoleLog = spyOn(console, 'info').mockImplementation(() => {})
  spies.push(consoleLog)
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
  const trace = new TaskOpenTrace(null, async () => { throw new Error('Older host') })
  const finished = trace.finish('failed')
  await flushFrame()
  await flushFrame()
  await flushFrame()
  await expect(finished).resolves.toBeUndefined()
  expect(consoleLog.mock.calls[0][1]).toMatchObject({ taskId: null, outcome: 'failed' })
})
