import {
  appAgentAccessRequestSchema,
  appUpdateRequestSchema,
  appCallReadRequestSchema,
  appCallRequestSchema,
  appCallsRequestSchema,
  appCallStatsRequestSchema,
  appDeployPreflightRequestSchema,
  appDeployRequestSchema,
  appFileRequestSchema,
  appRequestSchema,
  appUiRequestSchema,
  appRevisionRequestSchema,
  appRunRequestSchema,
  appRunsRequestSchema,
  appScheduleCalendarRequestSchema,
  appScheduleRequestSchema,
  appScheduleSetRequestSchema,
  appSecretSetRequestSchema,
  appSessionRequestSchema,
  appConfigSetRequestSchema,
  appSignalActionRequestSchema,
  appSignalActionSaveRequestSchema,
  appSignalOccurrencesRequestSchema,
  appStepSourceRequestSchema,
  appVersionRequestSchema,
  appWebhookRequestSchema,
  type AppDeployReceipt,
  type AppSessionLink,
} from '@solus/contracts/apps'
import { appModelCallRequestSchema, appModelCallsRequestSchema } from '@solus/contracts/app-models'
import {
  appContainerLogsRequestSchema,
  appContainerManageRequestSchema,
  appContainerRequestSchema,
  appContainerRunRequestSchema,
  appDeploymentLogsRequestSchema,
  appPublishRequestSchema,
  appTailscaleKeySetRequestSchema,
} from '@solus/contracts/app-deployments'
import { ANY_ORGANIZATION } from '../../admission/principal'
import type { AppDeployPreflights } from '../../apps/app-deploy-preflight'
import type { AppModelCalls } from '../../apps/app-model-calls'
import type { AppSchedules } from '../../apps/app-schedules'
import type { AppSignals } from '../../apps/app-signals'
import type { AppWebhooks } from '../../apps/app-webhooks'
import type { AppWorkflows } from '../../apps/app-workflows'
import type { Apps } from '../../apps/apps'
import type { AppDeployments } from '../../apps/deployments/app-deployments'
import type { HostedAppContainers } from '../../apps/deployments/hosted-app-containers'
import { setTailscaleAuthKey } from '../../apps/deployments/tailscale-key'
import { linkSessionItem, readAppSessionLinks, unlinkAppSession } from '../../data/sessions/session-links'
import { getSessionRecords } from '../../data/sessions/session-records'
import { hostAttribution } from '../../data/stored-attribution'
import { workspaceToolContext } from '../../data/workspace/tool-context'
import type { SolusServer } from '../server'

/** The parts of the apps domain that answer an RPC. */
export interface AppHandlerParts {
  apps: Apps
  schedules: AppSchedules
  webhooks: AppWebhooks
  workflows: AppWorkflows
  signals: AppSignals
  modelCalls: AppModelCalls
  deployments: AppDeployments
  hostedContainers: HostedAppContainers
  preflights: AppDeployPreflights
}

/** The app RPCs (docs/plans/apps.md §10). The Apps service checks the caller on every one. */
export function registerAppHandlers(server: SolusServer, { apps, schedules, webhooks, workflows, signals, modelCalls, deployments, hostedContainers, preflights }: AppHandlerParts): void {
  server.register('appList', (_args, ctx) => apps.list(ctx))
  server.register('appRead', ([input], ctx) => apps.read(ctx, appRequestSchema.parse(input).appId))
  server.register('appUi', ([input], ctx) => {
    const request = appUiRequestSchema.parse(input)
    return apps.ui(ctx, request.appId, request.page)
  })
  server.register('appIcon', ([input], ctx) => apps.icon(ctx, appRequestSchema.parse(input).appId))
  server.register('appCall', ([input], ctx) => {
    const request = appCallRequestSchema.parse(input)
    return apps.call(ctx, request.appId, request.name, request.argumentsJson)
  })
  server.register('appStop', ([input], ctx) => apps.stop(ctx, appRequestSchema.parse(input).appId))
  server.register('appStart', ([input], ctx) => apps.start(ctx, appRequestSchema.parse(input).appId))
  server.register('appDelete', ([input], ctx) => apps.delete(ctx, appRequestSchema.parse(input).appId))
  server.register('appSetAgentAccess', ([input], ctx) => {
    const request = appAgentAccessRequestSchema.parse(input)
    return apps.setAgentAccess(ctx, request.appId, request.enabled)
  })
  server.register('appUpdate', ([input], ctx) => {
    const request = appUpdateRequestSchema.parse(input)
    return apps.update(ctx, request.appId, request.patch)
  })

  // Revisions and versions
  server.register('appVersions', ([input], ctx) => apps.versions(ctx, appRequestSchema.parse(input).appId))
  server.register('appVersionDiff', ([input], ctx) => {
    const request = appVersionRequestSchema.parse(input)
    return apps.versionDiff(ctx, request.appId, request.version)
  })
  server.register('appActivate', ([input], ctx) => {
    const request = appVersionRequestSchema.parse(input)
    return apps.activate(ctx, request.appId, request.version)
  })
  server.register('appRevisions', ([input], ctx) => apps.revisions(ctx, appRequestSchema.parse(input).appId))
  server.register('appRevisionDiff', ([input], ctx) => {
    const request = appRevisionRequestSchema.parse(input)
    return apps.revisionDiff(ctx, request.appId, request.commit, request.against)
  })
  server.register('appStepSource', ([input], ctx) => {
    const { appId, ...request } = appStepSourceRequestSchema.parse(input)
    return apps.stepSource(ctx, appId, request)
  })
  server.register('appDeploy', async ([input], ctx): Promise<AppDeployReceipt> => {
    const request = appDeployRequestSchema.parse(input)
    // The owner deploys from the Manage page: the version is theirs, not an agent's.
    const { user } = ctx.actor
    const deployed = await apps.deploy(ctx, { app: request.appId, revision: request.commit, createdBy: user ? { kind: 'user', user } : hostAttribution() })
    return { app: deployed.app, version: deployed.version, active: deployed.active, error: deployed.error }
  })
  server.register('appBuildLog', ([input], ctx) => {
    const request = appVersionRequestSchema.parse(input)
    return apps.buildLog(ctx, request.appId, request.version)
  })
  server.register('appDeployPreflight', ([input], ctx) => {
    const request = appDeployPreflightRequestSchema.parse(input)
    return preflights.preflight(ctx, request.appId, request.commit)
  })

  // The deployment: the published copy of the app (docs/plans/app-deploy.md)
  server.register('appPublish', ([input], ctx) => deployments.publish(ctx, appPublishRequestSchema.parse(input)))
  server.register('appUnpublish', ([input], ctx) => deployments.unpublish(ctx, appRequestSchema.parse(input).appId))
  server.register('appDeployment', ([input], ctx) => deployments.view(ctx, appRequestSchema.parse(input).appId))
  server.register('appDeploymentLogs', ([input], ctx) => {
    const request = appDeploymentLogsRequestSchema.parse(input)
    return deployments.logs(ctx, request.appId, request.lines)
  })
  server.register('appPublishPlaces', (_args, ctx) => deployments.publishPlaces(ctx))
  server.register('appTailscaleKeySet', async ([input], ctx) => {
    // The places answer first: they refuse a caller who is not the owner of this host.
    await deployments.publishPlaces(ctx)
    setTailscaleAuthKey(appTailscaleKeySetRequestSchema.parse(input).value)
    return deployments.publishPlaces(ctx)
  })

  // The container of another Solus's app, on this host (§8.5)
  server.register('appContainerRun', ([input], ctx) => hostedContainers.run(ctx.principal, appContainerRunRequestSchema.parse(input)))
  server.register('appContainerStatus', ([input], ctx) => hostedContainers.status(ctx.principal, appContainerRequestSchema.parse(input)))
  server.register('appContainerLogs', ([input], ctx) => hostedContainers.logs(ctx.principal, appContainerLogsRequestSchema.parse(input)))
  server.register('appContainerRemove', ([input], ctx) => hostedContainers.remove(ctx.principal, appContainerRequestSchema.parse(input)))
  server.register('appContainerManage', ([input], ctx) => hostedContainers.manage(ctx.principal, appContainerManageRequestSchema.parse(input)))

  // Schedules, secrets, config, webhooks
  server.register('appSchedules', ([input], ctx) => schedules.list(ctx, appRequestSchema.parse(input).appId))
  server.register('appScheduleSet', ([input], ctx) => {
    const request = appScheduleSetRequestSchema.parse(input)
    return schedules.set(ctx, request.appId, request.name, request.enabled)
  })
  server.register('appScheduleRun', ([input], ctx) => {
    const request = appScheduleRequestSchema.parse(input)
    return schedules.runNow(ctx, request.appId, request.name)
  })
  server.register('appScheduleCalendar', ([input], ctx) => {
    const request = appScheduleCalendarRequestSchema.parse(input)
    return schedules.calendar(ctx, request.appId, request.edges)
  })
  server.register('appSecretSet', ([input], ctx) => {
    const request = appSecretSetRequestSchema.parse(input)
    return apps.secretSet(ctx, request.appId, request.name, request.value)
  })
  server.register('appConfigSet', ([input], ctx) => {
    const request = appConfigSetRequestSchema.parse(input)
    return apps.configSet(ctx, request.appId, request.name, request.value)
  })
  server.register('appWebhooks', ([input], ctx) => webhooks.list(ctx, appRequestSchema.parse(input).appId))
  server.register('appWebhookRotateSecret', ([input], ctx) => {
    const request = appWebhookRequestSchema.parse(input)
    return webhooks.rotateSecret(ctx, request.appId, request.name)
  })

  // The call log and the metrics
  server.register('appCalls', ([input], ctx) => {
    const { appId, limit, ...filter } = appCallsRequestSchema.parse(input)
    return apps.calls(ctx, appId, limit, filter)
  })
  server.register('appCallRead', ([input], ctx) => {
    const request = appCallReadRequestSchema.parse(input)
    return apps.callRead(ctx, request.appId, request.callId)
  })
  server.register('appMetrics', ([input], ctx) => apps.metrics(ctx, appRequestSchema.parse(input).appId))
  server.register('appCallStats', ([input], ctx) => {
    const { appId, ...filter } = appCallStatsRequestSchema.parse(input)
    return apps.callStats(ctx, appId, filter)
  })

  // Workflow runs
  server.register('appRuns', ([input], ctx) => {
    const { appId, ...options } = appRunsRequestSchema.parse(input)
    return workflows.list(ctx, appId, options)
  })
  server.register('appRunRead', ([input], ctx) => {
    const request = appRunRequestSchema.parse(input)
    return workflows.read(ctx, request.appId, request.runId)
  })
  server.register('appRunTerminate', ([input], ctx) => {
    const request = appRunRequestSchema.parse(input)
    return workflows.terminate(ctx, request.appId, request.runId)
  })
  server.register('appRunRetry', ([input], ctx) => {
    const request = appRunRequestSchema.parse(input)
    return workflows.retry(ctx, request.appId, request.runId)
  })
  server.register('appRunDismiss', ([input], ctx) => {
    const request = appRunRequestSchema.parse(input)
    return workflows.dismiss(ctx, request.appId, request.runId)
  })

  // Model calls (docs/plans/app-models.md)
  server.register('appModelCalls', ([input], ctx) => {
    const { appId, ...options } = appModelCallsRequestSchema.parse(input)
    return modelCalls.listFor(ctx, appId, options)
  })
  server.register('appModelCallRead', ([input], ctx) => {
    const request = appModelCallRequestSchema.parse(input)
    return modelCalls.readFor(ctx, request.appId, request.callId)
  })
  server.register('appModelCallCancel', ([input], ctx) => {
    const request = appModelCallRequestSchema.parse(input)
    return modelCalls.cancelFor(ctx, request.appId, request.callId)
  })

  // Signals
  server.register('appSignals', ([input], ctx) => signals.list(ctx, appRequestSchema.parse(input).appId))
  server.register('appSignalOccurrences', ([input], ctx) => {
    const request = appSignalOccurrencesRequestSchema.parse(input)
    return signals.occurrences(ctx, request.appId, request.signal, request.limit)
  })
  server.register('appSignalActionSave', ([input], ctx) => {
    const request = appSignalActionSaveRequestSchema.parse(input)
    return signals.saveAction(ctx, request.appId, request)
  })
  server.register('appSignalActionDelete', ([input], ctx) => {
    const request = appSignalActionRequestSchema.parse(input)
    return signals.deleteAction(ctx, request.appId, request.actionId)
  })

  // App files
  server.register('appFiles', ([input], ctx) => apps.files(ctx, appRequestSchema.parse(input).appId))
  server.register('appFileRemove', ([input], ctx) => {
    const request = appFileRequestSchema.parse(input)
    return apps.fileRemove(ctx, request.appId, request.fileId)
  })

  server.register('appSessions', async ([input], ctx): Promise<AppSessionLink[]> => {
    const app = await apps.record(ctx, appRequestSchema.parse(input).appId)
    return appSessionLinks(app.id)
  })
  // The Sessions section's New: a session the owner started for the app links to it, as a deploy links the agent's session (decision 19).
  server.register('appSessionLink', async ([input], ctx): Promise<AppSessionLink[]> => {
    const request = appSessionRequestSchema.parse(input)
    const app = await apps.record(ctx, request.appId)
    // An organization session's links are on its Solus API, which holds no app links yet.
    const home = await workspaceToolContext(request.sessionId)
    if (home.remote || home.context.home.kind !== 'local') throw new Error('An app cannot be linked to an organization session yet.')
    const { user } = ctx.actor
    await linkSessionItem(request.sessionId, { target: { kind: 'app', targetId: app.id, hostId: home.context.home.hostId }, title: app.name }, user ? { kind: 'user', user } : hostAttribution())
    return appSessionLinks(app.id)
  })
  server.register('appSessionUnlink', async ([input], ctx): Promise<AppSessionLink[]> => {
    const request = appSessionRequestSchema.parse(input)
    const app = await apps.record(ctx, request.appId)
    await unlinkAppSession(app.id, request.sessionId)
    return appSessionLinks(app.id)
  })
}

/** The sessions linked to an app, the newest link first, each with how its record stands. */
async function appSessionLinks(appId: string): Promise<AppSessionLink[]> {
  const links = await readAppSessionLinks(appId)
  const sessions = await getSessionRecords(ANY_ORGANIZATION, links.map((link) => link.sessionId))
  return links.map((link) => {
    const session = sessions.get(link.sessionId)
    return {
      sessionId: link.sessionId,
      title: session ? session.customTitle ?? session.title ?? null : null,
      linkedAt: link.linkedAt,
      provider: session?.provider ?? null,
      status: session?.status ?? null,
      lastActivityAt: session?.lastActivityAt ?? null,
    }
  })
}
