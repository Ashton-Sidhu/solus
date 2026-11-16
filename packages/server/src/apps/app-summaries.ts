import type { AppAttention, AppSummary } from '@solus/contracts/apps'
import { callCountsSince, lastCallTimes, listSchedules, listVersions, type AppRecord, type AppVersionRecord } from '../data/apps/app-store'
import { lastFinishedRuns } from '../data/apps/app-workflow-store'
import { readAppSecrets } from './app-secrets'

/**
 * One app as a list shows it (docs/plans/apps.md §9.3): what runs, what waits
 * for a deploy, the calls of the last 24 hours, and what needs the owner.
 */

const DAY_MS = 24 * 60 * 60_000

/** What the batch reads of a list give each app's summary. */
export interface AppSummaryFacts {
  lastCallAt: number | null
  calls24h: number
  failed24h: number
}

/** One app's summary, with its own reads of the call log. */
export async function appSummaryOf(app: AppRecord): Promise<AppSummary> {
  const lastCalls = await lastCallTimes([app.id])
  const counts = await callCountsSince([app.id], Date.now() - DAY_MS)
  return appSummary(app, { lastCallAt: lastCalls.get(app.id) ?? null, calls24h: counts.get(app.id)?.calls ?? 0, failed24h: counts.get(app.id)?.failed ?? 0 })
}

export async function appSummary(app: AppRecord, facts: AppSummaryFacts): Promise<AppSummary> {
  const versions = await listVersions(app.id)
  const active = versions.find((version) => version.number === app.activeVersion) ?? null
  const latest = versions[0] ?? null
  return {
    id: app.id,
    slug: app.slug,
    name: app.customName ?? app.name,
    description: app.customDescription ?? app.description,
    manifestName: app.name,
    manifestDescription: app.description,
    colorHue: app.colorHue,
    organizationId: app.organizationId,
    activeVersion: app.activeVersion,
    latestVersion: latest?.number ?? null,
    latestRevision: app.latestRevision,
    hasUndeployedRevision: app.latestRevision !== null && !versions.some((version) => version.sourceCommit === app.latestRevision),
    buildingVersion: versions.find((version) => version.state === 'building')?.number ?? null,
    stopped: app.stopped,
    agentAccess: app.agentAccess,
    hasUi: active?.hasUi ?? false,
    operationCount: active?.descriptor.operations.length ?? 0,
    project: app.project,
    createdBy: app.createdBy,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    ...facts,
    attention: await attentionOf(app, active, latest),
  }
}

/**
 * What needs the owner (§9): the app is stopped, its newest version failed, a
 * secret is not set, or the last run of a schedule or a workflow failed on the
 * active version. A workflow run that failed on an older version waits for a
 * retry on the active version, so it is `workflow-stale`. A schedule that failed
 * on an older version runs again by itself, so it needs no one.
 */
async function attentionOf(app: AppRecord, active: AppVersionRecord | null, latest: AppVersionRecord | null): Promise<AppAttention[]> {
  const attention: AppAttention[] = []
  if (app.stopped) attention.push({ kind: 'stopped', detail: 'This app is stopped.' })
  if (latest && latest.state === 'failed' && latest.number > (app.activeVersion ?? 0)) {
    attention.push({ kind: 'version-failed', detail: `Version ${latest.number} did not start: ${latest.error ?? 'no reason was recorded'}` })
  }
  const secrets = readAppSecrets(app.id)
  for (const secret of active?.descriptor.secrets ?? []) {
    if (!secrets[secret.name]) attention.push({ kind: 'secret-missing', detail: `${secret.label} is not set.` })
  }
  if (!active) return attention
  const activeSince = active.activations.at(-1)?.at ?? active.createdAt
  for (const schedule of await listSchedules(app.id)) {
    if (schedule.lastOutcome !== 'failed' || (schedule.lastRunAt ?? 0) < activeSince) continue
    attention.push({ kind: 'schedule-failed', detail: `The schedule ${schedule.name} failed: ${schedule.lastError ?? 'no reason was recorded'}` })
  }
  if (active.descriptor.workflows.length > 0) attention.push(...await workflowAttention(app.id, active, activeSince))
  return attention
}

/** The last run of each workflow that failed and is not dismissed: on the active version, or on an older one. */
async function workflowAttention(appId: string, active: AppVersionRecord, activeSince: number): Promise<AppAttention[]> {
  const attention: AppAttention[] = []
  for (const run of await lastFinishedRuns(appId)) {
    if (run.state !== 'failed' || run.dismissedAt !== null) continue
    // A run from before the host kept its version ran on the active one when it finished after the activation.
    const ranOnActive = run.version === null ? (run.finishedAt ?? 0) >= activeSince : run.version === active.number
    if (ranOnActive) {
      attention.push({ kind: 'workflow-failed', detail: `The workflow ${run.workflow} failed: ${run.error ?? 'no reason was recorded'}`, runId: run.id })
    } else {
      const older = run.version === null ? 'an older version' : `v${run.version}`
      attention.push({ kind: 'workflow-stale', detail: `The last ${run.workflow} run failed on ${older}. v${active.number} has not run it yet.`, runId: run.id })
    }
  }
  return attention
}
