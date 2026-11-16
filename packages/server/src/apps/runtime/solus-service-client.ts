import { z } from 'zod'
import { APP_SERVICE_PATHS, appServiceAnswerSchema, type AppServiceModels, type AppServiceSignals, type AppServiceTool } from '@solus/contracts/app-deployments'
import { APP_MODEL_CALL_STATES, isFinishedModelCall } from '@solus/contracts/app-models'
import type { AppCaller, AppConfigValue, AppDescriptor, AppModelOperation } from '@solus/contracts/apps'
import type { AppRecord } from '../../data/apps/app-store'
import type { AppArrivedSignal, AppSignalSource } from '../app-signals'
import type { StoredValue } from '../app-storage'
import type { AppModelCallsPart, AppRemoteTools, AppSignalSink } from '../apps'

/**
 * The service API of Solus, as a deployment calls it (docs/plans/app-deploy.md
 * §5.2). A deployment knows its Solus only as a URL and its app key. It asks
 * for what Solus owns: a tool of an app connection, which Solus runs with the
 * owner's connection, the delivery of a signal to the owner's signal
 * actions, and a model call, which Solus runs with the owner's model account.
 * When Solus does not answer, only that call fails.
 */

const TIMEOUT_MS = 120_000
/** How often a deployment asks for a model call that it waits for. No request stays open for the whole call: a tunnel ends a long one. */
const MODEL_POLL_MS = 1500

const startedCallSchema = z.object({ id: z.string() })
const endedCallSchema = z.object({ status: z.enum(APP_MODEL_CALL_STATES), result: z.json().optional(), error: z.string().nullable().optional() })

export class SolusServiceClient implements AppRemoteTools, AppSignalSink, AppModelCallsPart {
  constructor(private readonly solusUrl: string, private readonly appKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}

  private async ask(path: string, body: AppServiceTool | AppServiceSignals | AppServiceModels): Promise<StoredValue> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.solusUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.appKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('Solus did not answer. This app needs its Solus for that.')
    }
    if (response.status === 401) throw new Error('Solus refused the key of this app. Its owner must publish it again.')
    const answer = appServiceAnswerSchema.safeParse(await response.json().catch(() => null))
    if (!answer.success) throw new Error(`Solus answered ${response.status} with no result.`)
    if (!answer.data.ok) throw new Error(answer.data.error)
    return answer.data.value
  }

  call(request: AppServiceTool): Promise<StoredValue> {
    return this.ask(APP_SERVICE_PATHS.tool, request)
  }

  async emitted(_app: AppRecord, _descriptor: AppDescriptor, signals: readonly AppArrivedSignal[], source: AppSignalSource): Promise<void> {
    if (signals.length === 0) return
    await this.ask(APP_SERVICE_PATHS.signals, { signals: signals.map(({ name, payload, id }) => ({ name, payload, id })), source })
  }

  /** What the app's code asks of `ctx.models`. `models.run` is a start and then reads until the call ended. */
  async hostRequest(_app: AppRecord, _descriptor: AppDescriptor, config: { readonly [name: string]: AppConfigValue }, method: string, input: StoredValue, caller: AppCaller): Promise<StoredValue> {
    const code = (asked: 'models.start' | 'models.get' | 'models.list' | 'models.cancel', value: StoredValue) => this.ask(APP_SERVICE_PATHS.models, { from: 'code', method: asked, input: value, config: { ...config }, caller })
    switch (method) {
      case 'models.start':
      case 'models.get':
      case 'models.list':
      case 'models.cancel':
        return code(method, input)
      case 'models.run': {
        const { id } = startedCallSchema.parse(await code('models.start', input))
        for (;;) {
          const call = endedCallSchema.parse(await code('models.get', { id }))
          if (isFinishedModelCall(call.status)) {
            if (call.status !== 'done') throw new Error(call.error ?? `The model call was ${call.status}.`)
            return call.result ?? null
          }
          await this.wait(MODEL_POLL_MS)
        }
      }
      default:
        throw new Error(`The host does not answer ${method} here.`)
    }
  }

  /** What the app's UI asks of `@models`. */
  uiCall(_app: AppRecord, operation: AppModelOperation, input: StoredValue): Promise<StoredValue> {
    return this.ask(APP_SERVICE_PATHS.models, { from: 'ui', operation, input })
  }
}
