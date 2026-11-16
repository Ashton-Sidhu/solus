import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appModelRequestSchema, type AppModelCallRecord, type AppModelRequest } from '@solus/contracts/app-models'
import { appDescriptorSchema, type AppCaller, type AppDescriptor } from '@solus/contracts/apps'
import type { NormalizedEvent } from '@solus/contracts/types'
import { AppModelCalls } from '@solus/server/apps/app-model-calls'
import type { ModelCallLog } from '@solus/server/apps/app-observability'
import type { StoredValue } from '@solus/server/apps/app-storage'
import type { AppRecord } from '@solus/server/data/apps/app-store'
import type { AgentDispatcher, AgentRunRequest, AgentRunResult } from '@solus/server/execution/agents/agent-runner'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'

const root = mkdtempSync(join(tmpdir(), 'solus-app-model-calls-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// SAFETY: the model calls read only the id and the organization of an app.
const app = { id: 'app1', organizationId: 'local', ownerKey: 'owner' } as AppRecord
const descriptor: AppDescriptor = appDescriptorSchema.parse({
  solusApp: 3, name: 'CI', description: '',
  operations: [{ name: 'durations', kind: 'query', description: 'Build times.', input: { type: 'object', properties: {} } }],
  config: [{ name: 'analyst', label: 'Analyst', type: 'model' }, { name: 'hour', label: 'Hour', type: 'number', default: 9 }],
})
const config = { analyst: 'claude-sonnet-5-5', hour: 9 }
const caller: AppCaller = { kind: 'ui' }
// SAFETY: the tools of a model call read nothing of the context.
const toolContext = {} as AgentToolContext

/** One provider run the test drives: its events, its tools, and its end. */
interface FakeRun {
  request: AgentRunRequest
  /** Settles when the run ends: the call has its outcome from it. */
  done: Promise<unknown>
  finish(output?: string): void
  fail(message: string): void
  cancelled: boolean
}

let runs: FakeRun[] = []
let operationCalls: { operation: string; input: StoredValue; caller: AppCaller }[] = []
/** What the calls wrote to the call log, in order. */
let logged: { step: 'begin' | 'end'; record: AppModelCallRecord }[] = []
const callLog: ModelCallLog = {
  begin: async (record) => void logged.push({ step: 'begin', record: structuredClone(record) }),
  end: async (record) => void logged.push({ step: 'end', record: structuredClone(record) }),
}

function setup(resolveModel = (modelId: string) => ({ provider: 'claude-code' as const, model: modelId || 'default-model' })) {
  const dispatcher: AgentDispatcher = {
    runAgent(request) {
      let resolve: (result: AgentRunResult) => void = () => {}
      let reject: (error: Error) => void = () => {}
      const done = new Promise<AgentRunResult>((yes, no) => { resolve = yes; reject = no })
      const run: FakeRun = {
        request,
        done: done.catch(() => {}),
        cancelled: false,
        finish: (output = '') => resolve({ sessionId: null, output, toolCallCount: 0, permissionDenials: [], exitCode: 0, signal: null }),
        fail: (message) => reject(new Error(message)),
      }
      runs.push(run)
      for (const waiter of runWaiters.splice(0)) waiter()
      // SAFETY: the model calls use only `done` and `cancel` of a run.
      return { done, cancel: () => { run.cancelled = true; reject(new Error('cancelled')) }, sessionId: Promise.resolve(null), handle: {} } as never
    },
  }
  return new AppModelCalls({
    record: async () => app,
    callOperation: async (_appId, operation, input, from) => {
      operationCalls.push({ operation, input, caller: from })
      return { p50: 7 }
    },
  }, { dispatcher, resolveModel, root: () => root, callLog })
}

function request(given: Partial<AppModelRequest> & { prompt: string }): AppModelRequest {
  return appModelRequestSchema.parse({ setting: 'analyst', ...given })
}

/** Wakes each wait of `runStarted` when the dispatcher takes a run. */
let runWaiters: (() => void)[] = []

/**
 * Settles when the dispatcher has taken `count` runs. A call reads its model
 * and writes its record before its run starts, so a fixed wait is too short
 * on a busy machine.
 */
async function runStarted(count: number): Promise<void> {
  while (runs.length < count) await new Promise<void>((resolve) => runWaiters.push(resolve))
}
const emit = (run: FakeRun, event: NormalizedEvent) => run.request.onEvent?.(event)

beforeEach(() => {
  runs = []
  runWaiters = []
  operationCalls = []
  logged = []
})

test('a call runs with the model its setting names, streams its text, uses the operations it names, and keeps the result in its shape', async () => {
  // WHY: this is the whole promise (docs/plans/app-models.md §2): the owner picks the model, the UI sees the call as it runs, and the app gets a typed result.
  const calls = setup()
  const output = { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] }
  const { id } = await calls.start(app, descriptor, config, request({ prompt: 'Find waste.', input: { jobs: 3 }, tools: ['durations'], output }), caller)
  await runStarted(1)
  const run = runs[0]
  expect(run.request).toMatchObject({ provider: 'claude-code', model: 'claude-sonnet-5-5', reasoningEffort: 'low', persistence: 'ephemeral', unattended: true, bare: { webAccess: false } })
  expect(run.request.prompt).toContain('Find waste.')
  expect(run.request.prompt).toContain('{"jobs":3}')
  expect(run.request.tools.map((tool) => tool.name)).toEqual(['durations', 'submit_result'])

  emit(run, { type: 'text_chunk', text: 'Reading ' })
  emit(run, { type: 'text_chunk', text: 'the jobs.' })
  const first = await calls.get(app.id, id)
  expect(first).toMatchObject({ status: 'running', text: 'Reading the jobs.', textLength: 17 })
  // A watcher asks only for the text it does not have.
  expect(await calls.get(app.id, id, 8)).toMatchObject({ text: 'the jobs.', textFrom: 8 })

  const durations = await run.request.tools[0].execute({}, toolContext)
  expect(durations.ok).toBe(true)
  expect(operationCalls).toEqual([{ operation: 'durations', input: {}, caller: { kind: 'model', callId: id } }])
  await run.request.tools[1].execute({ result: { findings: ['cache node_modules'] } }, toolContext)
  emit(run, { type: 'task_complete', result: '', costUsd: 0.01, durationMs: 5, numTurns: 2, usage: { inputTokens: 1200, outputTokens: 80 }, sessionId: 's' })
  run.finish('Done.')
  const ended = await calls.wait(app.id, id)
  expect(ended).toMatchObject({ status: 'done', result: { findings: ['cache node_modules'] }, usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.01 } })
  expect(ended.steps).toMatchObject([{ tool: 'durations', state: 'done' }])
  // The record outlives the run: a new host process reads it from the app's folder.
  expect(await setup().get(app.id, id)).toMatchObject({ status: 'done', text: 'Reading the jobs.' })
})

test('without an output schema the result is the text the model ended with', async () => {
  const calls = setup()
  const { id } = await calls.start(app, descriptor, config, request({ prompt: 'Summarize.' }), caller)
  await runStarted(1)
  runs[0].finish('Three jobs repeat setup.')
  expect((await calls.wait(app.id, id)).result).toBe('Three jobs repeat setup.')
})

test('a model that ends without the result the app asked for fails the call', async () => {
  const calls = setup()
  const { id } = await calls.start(app, descriptor, config, request({ prompt: 'x', output: { type: 'object' } }), caller)
  await runStarted(1)
  runs[0].finish('I forgot.')
  expect(await calls.wait(app.id, id)).toMatchObject({ status: 'failed', error: 'The model ended without a result in the shape the app asked for.' })
})

test('the code names a model setting and its own operations, or the start fails', async () => {
  // WHY: a mistake in the app fails the code that started the call, not a call nobody watches.
  const calls = setup()
  await expect(calls.start(app, descriptor, config, request({ prompt: 'x', setting: 'hour' }), caller)).rejects.toThrow('This app has no model setting named hour.')
  await expect(calls.start(app, descriptor, config, request({ prompt: 'x', tools: ['deleteAll'] }), caller)).rejects.toThrow('This app has no operation named deleteAll to give the model.')
  expect(runs).toEqual([])
})

test('a model the host cannot run fails the call, and no other model runs in its place', async () => {
  const calls = setup(() => { throw new Error('This host has no model gpt-x. Choose another in the app\'s config.') })
  const { id } = await calls.start(app, descriptor, config, request({ prompt: 'x' }), caller)
  expect(await calls.wait(app.id, id)).toMatchObject({ status: 'failed', error: 'This host has no model gpt-x. Choose another in the app\'s config.' })
  expect(runs).toEqual([])
})

test('cancel stops the provider run and ends the call as cancelled', async () => {
  const calls = setup()
  const { id } = await calls.start(app, descriptor, config, request({ prompt: 'x' }), caller)
  await runStarted(1)
  const waiting = calls.wait(app.id, id)
  expect((await calls.cancel(app.id, id)).status).toBe('cancelled')
  expect(runs[0].cancelled).toBe(true)
  expect((await waiting).status).toBe('cancelled')
  // The rejected run that follows the cancel does not turn it into a failure.
  await runs[0].done
  expect((await calls.get(app.id, id))?.status).toBe('cancelled')
})

test('a call is one row of the call log: it begins when the call is queued and ends with the call', async () => {
  // WHY: the Activity log holds operation calls and model calls; a model call missing from it, or left "running", is a hole in the log.
  const calls = setup()
  const { id } = await calls.start(app, descriptor, config, request({ prompt: 'Summarize the builds.' }), caller)
  expect(logged).toMatchObject([{ step: 'begin', record: { id, status: 'queued', setting: 'analyst', prompt: 'Summarize the builds.' } }])
  await runStarted(1)
  await calls.cancel(app.id, id)
  expect(logged.map((entry) => [entry.step, entry.record.status])).toEqual([['begin', 'queued'], ['end', 'cancelled']])

  const { id: stopped } = await calls.start(app, descriptor, config, request({ prompt: 'x' }), caller)
  await runStarted(2)
  await setup().recover()
  expect(logged.at(-1)).toMatchObject({ step: 'end', record: { id: stopped, status: 'failed', error: 'The host stopped during this call.' } })
})

test('two calls of an app run at once and the third waits for one to end', async () => {
  const calls = setup()
  const ids = []
  for (const prompt of ['a', 'b', 'c']) ids.push((await calls.start(app, descriptor, config, request({ prompt }), caller)).id)
  await runStarted(2)
  expect(runs).toHaveLength(2)
  expect((await calls.get(app.id, ids[2]))?.status).toBe('queued')
  runs[0].finish('a')
  await calls.wait(app.id, ids[0])
  await runStarted(3)
  expect(runs).toHaveLength(3)
})

test('a call that was running when the host stopped is failed at boot', async () => {
  // WHY: an ephemeral provider run cannot continue (decision 5); a lying "running" is a bug.
  const calls = setup()
  const { id } = await calls.start(app, descriptor, config, request({ prompt: 'x' }), caller)
  await runStarted(1)
  const restarted = setup()
  await restarted.recover()
  expect(await restarted.get(app.id, id)).toMatchObject({ status: 'failed', error: 'The host stopped during this call.' })
})

test('a workflow step waits for the result, and a failed call fails the step', async () => {
  const calls = setup()
  const done = calls.hostRequest(app, descriptor, config, 'models.run', request({ prompt: 'x' }), caller)
  await runStarted(1)
  runs[0].finish('ok')
  expect(await done).toBe('ok')
  const failed = calls.hostRequest(app, descriptor, config, 'models.run', request({ prompt: 'y' }), caller)
  await runStarted(2)
  runs[1].fail('The provider refused the login.')
  await expect(failed).rejects.toThrow('The provider refused the login.')
})

test('the effort in any case, a timeout out of range, and a JSON Schema output are what an app means', () => {
  // WHY: the runner holds a step's timeout to its range; a model call does the same instead of refusing the call.
  const parsed = appModelRequestSchema.parse({ setting: 'analyst', prompt: 'x', effort: 'MEDIUM', timeoutSeconds: 2000, output: { type: 'object' } })
  expect(parsed).toMatchObject({ effort: 'medium', timeoutSeconds: 900, output: { type: 'object' } })
  expect(appModelRequestSchema.parse({ setting: 'analyst', prompt: 'x', timeoutSeconds: 1 }).timeoutSeconds).toBe(10)
})

test('a request the host does not take fails in one line that names the field', async () => {
  const calls = setup()
  await expect(calls.hostRequest(app, descriptor, config, 'models.start', { setting: 'analyst', prompt: '' }, caller))
    .rejects.toThrow(/^This is not a model call the host takes: .*prompt/)
  expect(runs).toEqual([])
})
