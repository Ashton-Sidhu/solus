import { APP_SERVICE_PATHS, appServiceModelsSchema, appServiceSignalsSchema, appServiceToolSchema, type AppServiceAnswer } from '@solus/contracts/app-deployments'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { loadApp, loadVersion } from '../../data/apps/app-store'
import { createLogger } from '../../logger'
import type { AppSignals } from '../app-signals'
import type { StoredValue } from '../app-storage'
import type { AppModelCallsPart, Apps } from '../apps'
import type { AppDeployments } from './app-deployments'

const log = createLogger('apps', 'app-service-api.ts')

/**
 * The service API (docs/plans/app-deploy.md §5.2): what a deployment asks of
 * its Solus. The app key in the request names the app, and it grants nothing
 * by itself: a tool runs only for an app connection that the published
 * version names (§6), with the connection of the app's owner. A visitor of a
 * deployment is no person of Solus, so a user connection is never used here.
 * No token of a connection is in an answer (decision 15). A model call runs
 * here with the owner's model account, for each caller of the deployment:
 * the app's own code decides who may start one.
 */

export interface AppServiceRequest {
  path: string
  /** The `Authorization` header. */
  authorization: string | undefined
  body: StoredValue
}

export interface AppServiceResponse {
  status: 200 | 400 | 401 | 404
  body: AppServiceAnswer
}

const refused = (status: 200 | 400 | 401 | 404, error: string): AppServiceResponse => ({ status, body: { ok: false, error } })

export interface AppServiceDeps {
  deployments: Pick<AppDeployments, 'publishedOfKey'>
  apps: Pick<Apps, 'hostRequest'>
  signals: Pick<AppSignals, 'emitted'>
  /** The model calls of the deployments: each operation a call uses as a tool runs in the deployment. Absent on a Solus that runs no model. */
  modelCalls?: AppModelCallsPart
}

export class AppServiceApi {
  constructor(private readonly deps: AppServiceDeps) {}

  async answer(request: AppServiceRequest): Promise<AppServiceResponse> {
    const key = /^Bearer (\S+)$/.exec(request.authorization ?? '')?.[1]
    const published = key ? await this.deps.deployments.publishedOfKey(key) : null
    if (!published) return refused(401, 'This key is not the key of a deployment of this Solus.')
    const app = await loadApp(ANY_ORGANIZATION, published.appId)
    // The version the deployment runs, which can be older than the active one here.
    const version = app ? await loadVersion(app.id, published.version) : null
    if (!app || !version) return refused(404, 'This app has no such version in Solus.')
    try {
      if (request.path === APP_SERVICE_PATHS.tool) {
        const tool = appServiceToolSchema.safeParse(request.body)
        if (!tool.success) return refused(400, 'The tool call is not valid.')
        if (!version.descriptor.appIntegrations.includes(tool.data.slug)) {
          return refused(200, `A published app uses only its app connections. Name ${tool.data.slug} in \`appIntegrations\` in app.ts, and publish again.`)
        }
        // No authority: an app connection is the owner's, whoever calls.
        return { status: 200, body: { ok: true, value: await this.deps.apps.hostRequest(app, version, 'tool', tool.data, { kind: 'ui' }, null) } }
      }
      if (request.path === APP_SERVICE_PATHS.signals) {
        const emitted = appServiceSignalsSchema.safeParse(request.body)
        if (!emitted.success) return refused(400, 'The signals are not valid.')
        await this.deps.signals.emitted(app, version.descriptor, emitted.data.signals, emitted.data.source)
        return { status: 200, body: { ok: true, value: null } }
      }
      if (request.path === APP_SERVICE_PATHS.models) {
        const asked = appServiceModelsSchema.safeParse(request.body)
        if (!asked.success) return refused(400, 'The model call is not valid.')
        if (!this.deps.modelCalls) return refused(200, 'The Solus of this app runs no model.')
        const value = asked.data.from === 'ui'
          ? await this.deps.modelCalls.uiCall(app, asked.data.operation, asked.data.input)
          : await this.deps.modelCalls.hostRequest(app, version.descriptor, asked.data.config, asked.data.method, asked.data.input, asked.data.caller)
        return { status: 200, body: { ok: true, value } }
      }
    } catch (error) {
      // The reason is for the app's code, as the reason of a failed tool is in Solus.
      const reason = error instanceof Error ? error.message : String(error)
      log.info('app_service_call_failed', { appId: app.id, path: request.path, error: reason })
      return refused(200, reason)
    }
    return refused(404, 'The service API has no such call.')
  }
}
