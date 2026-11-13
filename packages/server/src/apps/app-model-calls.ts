import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  APP_MODEL_INPUT_MAX_BYTES, APP_MODEL_TEXT_MAX_CHARS, appModelCallArgumentsSchema, appModelCallRecordSchema, appModelRequestSchema, isFinishedModelCall,
  type AppModelCallRecord, type AppModelCallView, type AppModelRequest, type AppModelStep,
} from '@solus/contracts/app-models'
import type { AppCaller, AppConfigValue, AppDescriptor, AppModelOperation } from '@solus/contracts/apps'
import type { NormalizedEvent, TextGenerationModelSelection } from '@solus/contracts/types'
import { ulid } from '@solus/contracts/ulid'
import { SPAN_SERVICES } from '../data/insights/registries'
import type { AppRecord } from '../data/apps/app-store'
import type { AgentDispatcher, AgentRun } from '../execution/agents/agent-runner'
import type { AgentTool } from '../execution/agents/tools/agent-tool'
import { hostPolicies } from '../host/policy/host-policy-store'
import { resolveModelId } from '../host/settings'
import { inputFieldsFor } from '../integrations/integration-tools'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { renameRetrying } from '../platform/rename-retry'
import { emitAppActivity } from './app-events'
import type { StoredValue } from './app-storage'
import type { AppAuthority } from './apps'

const log = createLogger('apps', 'app-model-calls.ts')

/**
 * An app's model calls (docs/plans/app-models.md): one request of the app's
 * code to a model, kept as a record in the app's data folder. A mutation or a
 * workflow step starts a call; the call runs as a bare, ephemeral provider run
 * whose only tools are the operations the request names and, with an output
 * schema, `submit_result`. The UI reads the record while it runs.
 */

/** The calls of one app that run at once; the others wait in order. */
const MAX_RUNNING_PER_APP = 2
/** The records an app keeps, the newest first. */
const MAX_RECORDS_PER_APP = 500
/** A running call is written at most this often; its status changes are written at once. */
const WRITE_EVERY_MS = 1000
const RESULT_MAX_BYTES = 1024 * 1024
const TOOL_RESULT_MAX_CHARS = 20_000
const SUBMIT_TOOL = 'submit_result'
const HOST_STOPPED = 'The host stopped during this call.'

/** What a call needs of `Apps`. */
export interface AppModelHost {
  /** The app, when the authority may use it. */
  record(authority: AppAuthority, idOrSlug: string): Promise<AppRecord>
  /** Runs one operation of the app as a tool of a call. */
  callOperation(appId: string, operation: string, input: StoredValue, caller: AppCaller, authority: null): Promise<StoredValue>
}

export interface AppModelCallsDeps {
  dispatcher: AgentDispatcher
  /** The provider and model a model setting names. `resolveModelId` on a host. */
  resolveModel?: (modelId: string) => TextGenerationModelSelection
  /** The folder of the apps' data. */
  root?: () => string
  now?: () => number
}

interface LiveCall {
  record: AppModelCallRecord
  app: AppRecord
  descriptor: AppDescriptor
  request: AppModelRequest
  run: AgentRun | null
  waiters: ((record: AppModelCallRecord) => void)[]
  writtenAt: number
}

export class AppModelCalls {
  private readonly live = new Map<string, LiveCall>()
  private readonly waiting = new Map<string, LiveCall[]>()

  constructor(private readonly host: AppModelHost, private readonly deps: AppModelCallsDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private folder(appId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(appId)) throw new Error('This app has no data folder: its id is not a folder name.')
    return join((this.deps.root ?? (() => join(dataDir(), 'apps', 'data')))(), appId, 'model-calls')
  }

  // ─── Entries ───

  /** What the app's code asks for (docs/plans/app-models.md §3). The runner refuses `start` and `cancel` in a query. */
  async hostRequest(app: AppRecord, descriptor: AppDescriptor, config: { readonly [name: string]: AppConfigValue }, method: string, input: StoredValue, caller: AppCaller): Promise<StoredValue> {
    switch (method) {
      case 'models.start':
        return { id: (await this.start(app, descriptor, config, appModelRequestSchema.parse(input), caller)).id }
      case 'models.run': {
        const ended = await this.wait(app.id, (await this.start(app, descriptor, config, appModelRequestSchema.parse(input), caller)).id)
        if (ended.status !== 'done') throw new Error(ended.error ?? `The model call was ${ended.status}.`)
        return ended.result
      }
      case 'models.get':
        return jsonOf(await this.get(app.id, appModelCallArgumentsSchema.parse(input).id))
      case 'models.list':
        return (await this.list(app.id, listOptionsSchema.parse(input))).map(jsonOf)
      case 'models.cancel':
        return jsonOf(viewOf(await this.cancel(app.id, appModelCallArgumentsSchema.parse(input).id), 0))
      default:
        throw new Error(`The host does not answer ${method} here.`)
    }
  }

  /** What the app's UI asks for: `@models/get` with the text it does not have yet, and `@models/cancel`. */
  async uiCall(app: AppRecord, operation: AppModelOperation, input: StoredValue): Promise<StoredValue> {
    const { id, textFrom } = appModelCallArgumentsSchema.parse(input)
    if (operation === 'cancel') return jsonOf(viewOf(await this.cancel(app.id, id), 0))
    const view = await this.get(app.id, id, textFrom)
    if (!view) throw new Error(`This app has no model call ${id}.`)
    return jsonOf(view)
  }

  async listFor(authority: AppAuthority, idOrSlug: string, options: { status?: AppModelCallRecord['status']; limit?: number }): Promise<AppModelCallView[]> {
    return this.list((await this.host.record(authority, idOrSlug)).id, options)
  }

  async readFor(authority: AppAuthority, idOrSlug: string, callId: string): Promise<AppModelCallView | null> {
    return this.get((await this.host.record(authority, idOrSlug)).id, callId)
  }

  async cancelFor(authority: AppAuthority, idOrSlug: string, callId: string): Promise<AppModelCallView> {
    return viewOf(await this.cancel((await this.host.record(authority, idOrSlug)).id, callId), 0)
  }

  // ─── Commands ───

  /** Makes the record of a call and queues it. The setting and the tools are checked here, so a mistake fails the code that started it. */
  async start(app: AppRecord, descriptor: AppDescriptor, config: { readonly [name: string]: AppConfigValue }, request: AppModelRequest, caller: AppCaller): Promise<AppModelCallRecord> {
    const field = descriptor.config.find((candidate) => candidate.name === request.setting)
    if (!field || field.type !== 'model') throw new Error(`This app has no model setting named ${request.setting}. Add it to \`config\` in app.ts with type: 'model'.`)
    for (const tool of request.tools) {
      if (!descriptor.operations.some((operation) => operation.name === tool)) throw new Error(`This app has no operation named ${tool} to give the model.`)
    }
    if (request.input !== undefined && Buffer.byteLength(JSON.stringify(request.input)) > APP_MODEL_INPUT_MAX_BYTES) {
      throw new Error('The input of a model call is at most 256 KiB. Send a summary, or give the model an operation that reads the rest.')
    }
    const modelId = String(config[request.setting] ?? '')
    const record: AppModelCallRecord = {
      id: ulid(), appId: app.id, setting: request.setting, provider: null, model: modelId || null, effort: request.effort,
      status: 'queued', prompt: request.prompt, tools: request.tools, text: '', steps: [], result: null, error: null, usage: null,
      caller, createdAt: this.now(), startedAt: null, endedAt: null,
    }
    const call: LiveCall = { record, app, descriptor, request, run: null, waiters: [], writtenAt: 0 }
    this.live.set(record.id, call)
    await this.write(call)
    log.info('app_model_call_queued', { appId: app.id, callId: record.id, setting: request.setting })
    const queue = this.waiting.get(app.id) ?? []
    queue.push(call)
    this.waiting.set(app.id, queue)
    this.drain(app.id)
    return record
  }

  /** Waits for a call to end and answers its record. */
  async wait(appId: string, callId: string): Promise<AppModelCallRecord> {
    const call = this.live.get(callId)
    if (call) return new Promise((resolve) => call.waiters.push(resolve))
    const record = await this.read(appId, callId)
    if (!record) throw new Error(`This app has no model call ${callId}.`)
    return record
  }

  /** Stops a queued or running call. A call that ended stays as it ended. */
  async cancel(appId: string, callId: string): Promise<AppModelCallRecord> {
    const call = this.live.get(callId)
    if (!call || call.record.appId !== appId) {
      const record = await this.read(appId, callId)
      if (!record) throw new Error(`This app has no model call ${callId}.`)
      return record
    }
    const queue = this.waiting.get(appId)
    if (queue?.includes(call)) queue.splice(queue.indexOf(call), 1)
    call.run?.cancel()
    await this.finish(call, 'cancelled', null, null)
    return call.record
  }

  // ─── Reads ───

  /** One call; `textFrom` cuts the text that the reader already has. */
  async get(appId: string, callId: string, textFrom = 0): Promise<AppModelCallView | null> {
    const live = this.live.get(callId)
    const record = live && live.record.appId === appId ? live.record : await this.read(appId, callId)
    return record ? viewOf(record, textFrom) : null
  }

  /** The newest calls, without their text. */
  async list(appId: string, options: { status?: AppModelCallRecord['status']; limit?: number } = {}): Promise<AppModelCallView[]> {
    const views: AppModelCallView[] = []
    for (const id of await this.ids(appId)) {
      if (views.length >= (options.limit ?? 100)) break
      const record = this.live.get(id)?.record ?? await this.read(appId, id)
      if (record && (!options.status || record.status === options.status)) views.push({ ...viewOf(record, 0), text: '' })
    }
    return views
  }

  // ─── Lifecycle ───

  /** At boot: a call that was queued or running when the host stopped cannot continue (decision 5). */
  async recover(): Promise<void> {
    const root = (this.deps.root ?? (() => join(dataDir(), 'apps', 'data')))()
    const appIds = await readdir(root).catch((): string[] => [])
    for (const appId of appIds) {
      for (const id of await this.ids(appId).catch((): string[] => [])) {
        const record = await this.read(appId, id)
        if (!record || isFinishedModelCall(record.status)) continue
        await this.save({ ...record, status: 'failed', error: HOST_STOPPED, endedAt: this.now() })
        log.warn('app_model_call_interrupted', { appId, callId: id })
      }
    }
  }

  /** A version became active: nothing to do; a call keeps the descriptor it started with. */
  async activated(): Promise<void> {}

  /** The app is gone: its calls stop. Its folder goes with the app's data. */
  async removed(app: AppRecord): Promise<void> {
    this.waiting.delete(app.id)
    for (const call of [...this.live.values()].filter((candidate) => candidate.app.id === app.id)) {
      call.run?.cancel()
      this.live.delete(call.record.id)
      for (const waiter of call.waiters.splice(0)) waiter({ ...call.record, status: 'cancelled', error: 'The app was deleted.' })
    }
  }

  // ─── The run ───

  private drain(appId: string): void {
    const running = [...this.live.values()].filter((call) => call.app.id === appId && call.record.status === 'running').length
    const queue = this.waiting.get(appId) ?? []
    for (let free = MAX_RUNNING_PER_APP - running; free > 0 && queue.length > 0; free -= 1) {
      const call = queue.shift()
      if (call) void this.run(call)
    }
  }

  private async run(call: LiveCall): Promise<void> {
    const { record, request, app } = call
    let selection: TextGenerationModelSelection
    try {
      selection = (this.deps.resolveModel ?? resolveModelId)(record.model ?? '')
    } catch (error) {
      await this.finish(call, 'failed', null, error instanceof Error ? error.message : String(error))
      return
    }
    record.provider = selection.provider
    record.model = selection.model
    record.status = 'running'
    record.startedAt = this.now()
    await this.write(call)
    log.info('app_model_call_started', { appId: app.id, callId: record.id, provider: selection.provider, model: selection.model })

    const submitted: { value: StoredValue; given: boolean } = { value: null, given: false }
    const tools = this.toolsFor(call, (value) => {
      submitted.value = value
      submitted.given = true
    })
    const organizationId = app.organizationId
    let chunked = false
    const onEvent = (event: NormalizedEvent): void => {
      if (event.type === 'text_chunk' && !event.parentToolUseId) {
        chunked = true
        this.appendText(call, event.text)
      } else if (event.type === 'assistant_message' && !event.parentToolUseId) {
        // A provider that streams no chunks gives its text as whole messages.
        if (!chunked) this.appendText(call, event.text)
        chunked = false
      } else if (event.type === 'task_complete') {
        record.usage = { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, costUsd: event.costUsd }
      }
    }
    try {
      call.run = this.deps.dispatcher.runAgent({
        organizationId,
        provider: selection.provider,
        prompt: promptOf(request),
        cwd: join(this.folder(app.id), '..'),
        tools,
        unattended: true,
        model: selection.model,
        reasoningEffort: request.effort,
        // The run is unattended: a tool that would ask is declined. Its only tools are the app's.
        permissionMode: hostPolicies().forWork(organizationId).clampMode(selection.provider === 'codex' ? 'plan' : 'full-access'),
        persistence: 'ephemeral',
        service: SPAN_SERVICES.apps,
        bare: { webAccess: false },
        timeoutMs: request.timeoutSeconds * 1000,
        onEvent,
      })
      const done = await call.run.done
      if (request.output && !submitted.given) throw new Error('The model ended without a result in the shape the app asked for.')
      await this.finish(call, 'done', request.output ? submitted.value : done.output, null)
    } catch (error) {
      await this.finish(call, 'failed', null, error instanceof Error ? error.message : String(error))
    }
  }

  /** The operations the request names, and `submit_result` when it asks for a shape. */
  private toolsFor(call: LiveCall, submit: (value: StoredValue) => void): AgentTool[] {
    const tools: AgentTool[] = call.request.tools.map((name) => {
      const operation = call.descriptor.operations.find((candidate) => candidate.name === name)
      const fields = operation ? inputFieldsFor({ ...operation.input, type: 'object' }) : null
      const tool: AgentTool = {
        name,
        description: (operation?.description || name).slice(0, 1000),
        inputFields: fields ?? {},
        requiresApproval: false,
        alwaysLoad: true,
        execute: async (input) => {
          const step: AppModelStep = { tool: name, state: 'running', startedAt: this.now(), endedAt: null, error: null }
          call.record.steps.push(step)
          void this.write(call, true)
          try {
            const value = await this.host.callOperation(call.app.id, name, z.json().parse(input), { kind: 'model', callId: call.record.id }, null)
            step.state = 'done'
            const text = JSON.stringify(value, null, 1) ?? 'null'
            return { ok: true, text: text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n… (cut; ask for less)` : text }
          } catch (error) {
            step.state = 'failed'
            step.error = error instanceof Error ? error.message : String(error)
            return { ok: false, text: step.error }
          } finally {
            step.endedAt = this.now()
            void this.write(call, true)
          }
        },
      }
      if (!fields) tool.passthroughInput = true
      return tool
    })
    const output = call.request.output
    if (output) {
      const fields = inputFieldsFor({ type: 'object', properties: { result: output }, required: ['result'] })
      const tool: AgentTool = {
        name: SUBMIT_TOOL,
        description: 'Give the app your result. Call it once, when you are done.',
        inputFields: fields ?? {},
        requiresApproval: false,
        alwaysLoad: true,
        execute: async (input) => {
          const value = z.json().parse(z.object({ result: z.json() }).parse(input).result)
          if (Buffer.byteLength(JSON.stringify(value)) > RESULT_MAX_BYTES) return { ok: false, text: 'The result is over 1 MiB. Give a shorter one.' }
          submit(value)
          return { ok: true, text: 'The app has your result. You are done.' }
        },
      }
      if (!fields) tool.passthroughInput = true
      tools.push(tool)
    }
    return tools
  }

  private appendText(call: LiveCall, text: string): void {
    if (call.record.text.length >= APP_MODEL_TEXT_MAX_CHARS) return
    call.record.text = (call.record.text + text).slice(0, APP_MODEL_TEXT_MAX_CHARS)
    void this.write(call)
  }

  private async finish(call: LiveCall, status: 'done' | 'failed' | 'cancelled', result: StoredValue, error: string | null): Promise<void> {
    if (isFinishedModelCall(call.record.status)) return
    call.record.status = status
    call.record.result = result
    call.record.error = error
    call.record.endedAt = this.now()
    await this.write(call, true)
    this.live.delete(call.record.id)
    log.info('app_model_call_finished', { appId: call.app.id, callId: call.record.id, status, error })
    for (const waiter of call.waiters.splice(0)) waiter(call.record)
    this.drain(call.app.id)
    await this.prune(call.app.id).catch((pruneError) => log.warn('app_model_calls_prune_failed', { appId: call.app.id, error: String(pruneError) }))
  }

  // ─── Records ───

  /** Writes a live call: at once for a change of status or step, else at most every `WRITE_EVERY_MS`. */
  private async write(call: LiveCall, now = call.record.status !== 'running'): Promise<void> {
    if (!now && this.now() - call.writtenAt < WRITE_EVERY_MS) return
    call.writtenAt = this.now()
    await this.save(call.record)
    // At most once a second while the model writes: a Manage page that shows the call reads it again.
    emitAppActivity(call.app.id, 'models')
  }

  private async save(record: AppModelCallRecord): Promise<void> {
    const folder = this.folder(record.appId)
    await mkdir(folder, { recursive: true })
    const temporary = join(folder, `${record.id}.${process.pid}.tmp`)
    await writeFile(temporary, JSON.stringify(record))
    await renameRetrying(temporary, join(folder, `${record.id}.json`))
  }

  private async read(appId: string, callId: string): Promise<AppModelCallRecord | null> {
    if (!/^[A-Za-z0-9]+$/.test(callId)) return null
    try {
      return appModelCallRecordSchema.parse(JSON.parse(await readFile(join(this.folder(appId), `${callId}.json`), 'utf8')))
    } catch {
      return null
    }
  }

  /** The ids of an app's records, the newest first: an id is a ULID. */
  private async ids(appId: string): Promise<string[]> {
    const names = await readdir(this.folder(appId)).catch((): string[] => [])
    return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort().reverse()
  }

  private async prune(appId: string): Promise<void> {
    for (const id of (await this.ids(appId)).slice(MAX_RECORDS_PER_APP)) {
      if (!this.live.has(id)) await rm(join(this.folder(appId), `${id}.json`), { force: true })
    }
  }
}

const listOptionsSchema = z.object({
  status: appModelCallRecordSchema.shape.status.optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

/** A view as the JSON a runner or a UI gets. */
function jsonOf(view: AppModelCallView | null): StoredValue {
  return view === null ? null : z.json().parse(JSON.parse(JSON.stringify(view)))
}

function promptOf(request: AppModelRequest): string {
  const parts = [request.prompt]
  if (request.input !== undefined) parts.push(`The data for this task, as JSON:\n${JSON.stringify(request.input)}`)
  if (request.output) parts.push(`When you are done, call ${SUBMIT_TOOL} once with your result.`)
  return parts.join('\n\n')
}

function viewOf(record: AppModelCallRecord, textFrom: number): AppModelCallView {
  return {
    id: record.id, setting: record.setting, provider: record.provider, model: record.model, effort: record.effort, status: record.status,
    prompt: record.prompt, tools: record.tools, text: record.text.slice(textFrom), textFrom: Math.min(textFrom, record.text.length), textLength: record.text.length,
    steps: record.steps, result: record.result, error: record.error, usage: record.usage, caller: record.caller,
    createdAt: record.createdAt, startedAt: record.startedAt, endedAt: record.endedAt,
  }
}
