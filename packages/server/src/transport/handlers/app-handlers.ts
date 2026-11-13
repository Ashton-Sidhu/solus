import {
  appCallRequestSchema,
  appCallsRequestSchema,
  appRequestSchema,
  appScheduleRequestSchema,
  appScheduleSetRequestSchema,
  appSecretSetRequestSchema,
  appVersionRequestSchema,
  type AppSessionLink,
} from '@solus/contracts/apps'
import { ANY_ORGANIZATION } from '../../admission/principal'
import type { AppSchedules } from '../../apps/app-schedules'
import type { AppWebhooks } from '../../apps/app-webhooks'
import type { Apps } from '../../apps/apps'
import { readAppSessionLinks } from '../../data/sessions/session-links'
import { getSessionRecords } from '../../data/sessions/session-records'
import type { SolusServer } from '../server'

/** The app RPCs (docs/plans/apps.md §10). The Apps service checks the caller on every one. */
export function registerAppHandlers(server: SolusServer, apps: Apps, schedules: AppSchedules, webhooks: AppWebhooks): void {
  server.register('appList', (_args, ctx) => apps.list(ctx))
  server.register('appRead', ([input], ctx) => apps.read(ctx, appRequestSchema.parse(input).appId))
  server.register('appUi', ([input], ctx) => apps.ui(ctx, appRequestSchema.parse(input).appId))
  server.register('appCall', ([input], ctx) => {
    const request = appCallRequestSchema.parse(input)
    return apps.call(ctx, request.appId, request.name, request.argumentsJson)
  })
  server.register('appStop', ([input], ctx) => apps.stop(ctx, appRequestSchema.parse(input).appId))
  server.register('appStart', ([input], ctx) => apps.start(ctx, appRequestSchema.parse(input).appId))
  server.register('appDelete', ([input], ctx) => apps.delete(ctx, appRequestSchema.parse(input).appId))
  server.register('appVersions', ([input], ctx) => apps.versions(ctx, appRequestSchema.parse(input).appId))
  server.register('appVersionDiff', ([input], ctx) => {
    const request = appVersionRequestSchema.parse(input)
    return apps.versionDiff(ctx, request.appId, request.version)
  })
  server.register('appActivate', ([input], ctx) => {
    const request = appVersionRequestSchema.parse(input)
    return apps.activate(ctx, request.appId, request.version)
  })
  server.register('appSchedules', ([input], ctx) => schedules.list(ctx, appRequestSchema.parse(input).appId))
  server.register('appScheduleSet', ([input], ctx) => {
    const request = appScheduleSetRequestSchema.parse(input)
    return schedules.set(ctx, request.appId, request.name, request.enabled)
  })
  server.register('appScheduleRun', ([input], ctx) => {
    const request = appScheduleRequestSchema.parse(input)
    return schedules.runNow(ctx, request.appId, request.name)
  })
  server.register('appSecretSet', ([input], ctx) => {
    const request = appSecretSetRequestSchema.parse(input)
    return apps.secretSet(ctx, request.appId, request.name, request.value)
  })
  server.register('appWebhooks', ([input], ctx) => webhooks.list(ctx, appRequestSchema.parse(input).appId))
  server.register('appCalls', ([input], ctx) => {
    const request = appCallsRequestSchema.parse(input)
    return apps.calls(ctx, request.appId, request.limit)
  })
  server.register('appSessions', async ([input], ctx): Promise<AppSessionLink[]> => {
    const app = await apps.record(ctx, appRequestSchema.parse(input).appId)
    const links = await readAppSessionLinks(app.id)
    const sessions = await getSessionRecords(ANY_ORGANIZATION, links.map((link) => link.sessionId))
    return links.map((link) => {
      const session = sessions.get(link.sessionId)
      return { sessionId: link.sessionId, title: session ? session.customTitle ?? session.title ?? null : null, linkedAt: link.linkedAt }
    })
  })
}
