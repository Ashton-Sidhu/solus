import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import {
  APP_PROTOCOL,
  appDescriptorSchema,
  appConfigValueProblem,
  appSlugOf,
  describeAppPermissions,
  parseAppCallName,
  resolveAppConfig,
  type AppBuildLog,
  type AppCallDetail,
  type AppCallTarget,
  type AppCallView,
  type AppCaller,
  type AppConfigValue,
  type AppDescriptor,
  type AppFileView,
  type AppCallStats,
  type AppMetrics,
  type AppRevisionDiff,
  type AppRevisionView,
  type AppState,
  type AppStepSource,
  type AppStorageOperation,
  type AppSummary,
  type AppUi,
  type AppUpdate,
  type AppVersionDiff,
  type AppVersionView,
} from '@solus/contracts/apps'
import type { AppServiceTool, AppUiIdentity, AppVersionPush } from '@solus/contracts/app-deployments'
import { isConnectionProvider } from '@solus/contracts/connections'
import { userKey, type Attribution } from '@solus/contracts/user'
import { ownerKeyOf, type Actor } from '../admission/actor'
import { ANY_ORGANIZATION, isHostOwner, organizationForNew, recordScopeOf, type Principal, type RecordScope } from '../admission/principal'
import {
  activateVersion,
  callCountsSince,
  deleteApp,
  failVersion,
  insertApp,
  insertVersion,
  lastCallTimes,
  latestVersionNumber,
  listApps,
  listCalls,
  listVersions,
  loadApp,
  loadCall,
  loadVersion,
  saveApp,
  saveVersionBuild,
  slugIsTaken,
  type AppCallFilter,
  type AppRecord,
  type AppVersionRecord,
} from '../data/apps/app-store'
import type { AppPreviewArguments, AppPreviewHost, AppPreviewValue } from '../data/works/artifact-preview'
import type { IntegrationGateway } from '../integrations/gateway'
import type { IntegrationStore } from '../integrations/integration-store'
import { hostAttribution } from '../data/stored-attribution'
import { hostUserKey } from '../host/host-user'
import { createLogger } from '../logger'
import { AppBuildError, type AppBuilder } from './app-builder'
import { emitAppDataChanged, emitAppsChanged } from './app-events'
import type { AppFiles } from './app-files'
import type { AppConnections } from './app-connections'
import type { AppModelCalls } from './app-model-calls'
import { AppIntegrationCalls } from './app-integrations'
import { appCallStats, appMetrics, beginCall, callDetail, callView, forgetCallCounts } from './app-observability'
import {
  BACKEND_FILE,
  MIGRATIONS_FOLDER,
  UI_FILE,
  AppProjectError,
  buildFiles,
  readProjectOrigin,
  readProjectSource,
  writeProjectOrigin,
  type AppBuild,
  type AppMigration,
} from './app-project'
import { AppRevisionConflict, type AppRepositories } from './app-repository'
import { AppOperationError, type AppRun, type AppRunnerHost, type AppRunners } from './app-runners'
import { scheduleTriggerProblem } from './app-schedules'
import { readAppSecrets, removeAppSecrets, writeAppSecret, type AppSecretValues } from './app-secrets'
import type { AppArrivedSignal, AppSignalSource } from './app-signals'
import type { AppStorage, StoredValue } from './app-storage'
import { appSummary, appSummaryOf } from './app-summaries'
import { findStepPlace, readStepSourceFiles } from './app-step-source'
import type { AppRunnable, AppWorkflowRunFace } from './app-workflows'

const log = createLogger('apps', 'apps.ts')

const APP_UNAVAILABLE = 'This app is not available.'
/** How long after a call the host says the app's summary again: a list shows its calls of 24 hours. */
const SUMMARY_AFTER_CALL_MS = 10_000
const DAY_MS = 24 * 60 * 60_000

const inputSchema = z.record(z.string(), z.json())
type CallInput = z.infer<typeof inputSchema>
const storageKeySchema = z.object({ key: z.string() })
const storageSetSchema = storageKeySchema.extend({ value: z.json() })

const toolRequestSchema = z.object({ slug: z.string(), tool: z.string(), input: z.json() })
const fileIdSchema = z.object({ id: z.string() })
const workflowStartSchema = z.object({ workflow: z.string(), input: z.json(), key: z.string().nullable() })
const workflowRunSchema = z.object({ runId: z.string() })
const workflowListSchema = z.object({ workflow: z.string().nullable(), limit: z.number().nullable() })

/** Who asks. The host's own work (a schedule, a webhook, a workflow) has the system principal and acts as the app's owner. */
export interface AppAuthority {
  principal: Principal
  actor: Actor
}

/** What a part of the host does when an app's active version changes, or the app goes: its schedules, its webhooks, its signals, and its runs. */
export interface AppLifecyclePart {
  activated(app: AppRecord, descriptor: AppDescriptor): Promise<void>
  removed(app: AppRecord): Promise<void>
}

/** What the runtime of a deployment asks its Solus for, in place of a connection of its own (§5.2). */
export interface AppRemoteTools {
  call(request: AppServiceTool): Promise<StoredValue>
}

/** The person of a call of the app's UI and what they may do: the owner, while an app has no other user. */
export function uiIdentityOf(authority: AppAuthority): AppUiIdentity {
  const { user } = authority.actor
  return user ? { user: { id: userKey(user.id), name: user.displayName }, role: 'owner' } : { role: 'owner' }
}

/** What `Apps` asks of the model calls part. On a host it is `AppModelCalls`; in a deployment, the Solus of the deployment answers (§5.2). */
export type AppModelCallsPart = Pick<AppModelCalls, 'hostRequest' | 'uiCall'>

/** What an operation's `ctx.workflows` reaches: the workflows part owns the runs. */
export interface AppWorkflowControls {
  startRun(app: AppRecord, descriptor: AppDescriptor, workflow: string, input: StoredValue, key: string | null, startedBy: AppCaller): Promise<AppWorkflowRunFace>
  getRun(app: AppRecord, runId: string): Promise<AppWorkflowRunFace | null>
  listRunFaces(app: AppRecord, options: { workflow: string | null; limit: number | null }): Promise<AppWorkflowRunFace[]>
  terminateRun(app: AppRecord, runId: string): Promise<AppWorkflowRunFace>
  /** Starts the open runs of an app again. */
  resume(appId: string): Promise<void>
}

/** Where the signals of a call that succeeded go: the signals part owns the occurrences. */
export interface AppSignalSink {
  emitted(app: AppRecord, descriptor: AppDescriptor, signals: readonly AppArrivedSignal[], source: AppSignalSource): Promise<void>
}

export interface AppSaveInput {
  /** The app project folder. */
  project: string
  /** The app the revision is for, by id or slug; absent for a new app, or for a project that names its app. */
  app?: string
  /** The name of a new app, when `app.ts` does not say it in a way the host can read before a build. */
  name?: string
  message?: string
  createdBy: Attribution
}

export interface AppSaveResult {
  app: AppSummary
  revision: string
  created: boolean
  /** The paths the revision before this one had and this one does not. */
  removed: string[]
}

export interface AppDeployInput {
  /** The app, by id or slug. */
  app: string
  /** The revision to build; the newest when absent. */
  revision?: string
  createdBy: Attribution
  /** The session whose agent deploys, so its conversation can open the app. */
  sessionId?: string | null
}

export interface AppDeployResult {
  app: AppSummary
  version: number
  /** False when the build or the start failed: the version before it still runs. */
  active: boolean
  error: string | null
  /** The end of the build's text, when the build is why the version failed. */
  buildLog: string | null
  permissionsNotice: string | null
  /** The declared secrets that have no value yet. */
  secretsMissing: string[]
}

export interface AppsDeps {
  gateway: Pick<IntegrationGateway, 'callAppTool' | 'toolsFor' | 'connectionStatus'>
  integrations: Pick<IntegrationStore, 'getBySlug'>
  /** The built-in connections an app names as roles. `hostConnections` on a host. */
  connections: AppConnections
  storage: AppStorage
  runners: AppRunners
  repositories: AppRepositories
  builder: AppBuilder
  files: AppFiles
  /** Runs an integration call as a person, for a caller with no person of its own. `withUserScope` on a host. */
  runAs?: <T>(personKey: string | null, run: () => T) => T
  /** In the runtime of a deployment: each integration tool is a call to Solus. */
  remoteTools?: AppRemoteTools
}

/** The files of one version that a host reads more than once. */
interface LoadedBuild {
  version: number
  backend: string | null
  migrations: AppMigration[]
  ui: string | null | undefined
}

/** Why a preview does not answer a call that reaches past the project: an integration or a model. */
function previewRefusal(name: string, target: AppCallTarget | null): string {
  if (!target) return `A preview cannot call ${name}.`
  return target.kind === 'models' ? 'A preview does not call a model.' : 'A preview does not call an integration.'
}

/** The name `app.ts` gives the app, read from its text: a save makes the app's record before any build. */
function declaredName(source: readonly { path: string; bytes: Buffer }[]): string | null {
  const entry = source.find((file) => file.path === 'app.ts' || file.path === 'app.js')
  const match = entry ? /defineApp\s*\(\s*\{[\s\S]*?\bname\s*:\s*(['"`])((?:(?!\1)[^\\\n])+)\1/.exec(entry.bytes.toString('utf8')) : null
  return match?.[2]?.trim() || null
}

/** What the owner typed, as the record keeps it: null when it is empty or the manifest's own text, so the app follows its manifest again. */
function ownerText(text: string | null, manifest: string): string | null {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' || trimmed === manifest ? null : trimmed
}

function short(commit: string | null): string {
  return commit ? commit.slice(0, 7) : 'none'
}

/**
 * Apps (docs/plans/apps.md §10): the one owner of an app's revisions, its
 * versions, and every call of its operations. Its UI, an agent, a schedule, a
 * webhook, and a workflow all enter through `callOperation`. An app is its
 * host owner's in this release, so every entry checks that first.
 */
export class Apps {
  private readonly builds = new Map<string, LoadedBuild>()
  private readonly lifecycle: AppLifecyclePart[] = []
  private workflows: AppWorkflowControls | null = null
  private signals: AppSignalSink | null = null
  private modelCalls: AppModelCallsPart | null = null
  private readonly integrationCalls: AppIntegrationCalls
  /** The apps whose summary the host says again soon, because they were called. */
  private readonly summaryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: AppsDeps) {
    this.integrationCalls = new AppIntegrationCalls(deps)
  }

  /** Installed once at boot: the schedules, the webhooks, the signals, and the runs of an app follow its active version. */
  addLifecyclePart(part: AppLifecyclePart): void {
    this.lifecycle.push(part)
  }

  /** Installed once at boot: the workflows part answers `ctx.workflows`. */
  useWorkflows(workflows: AppWorkflowControls): void {
    this.workflows = workflows
  }

  /** Installed once at boot: the signals part keeps what a call emitted. */
  useSignals(signals: AppSignalSink): void {
    this.signals = signals
  }

  /** Installed once at boot: the model calls part answers `ctx.models` and `@models` (docs/plans/app-models.md). */
  useModelCalls(modelCalls: AppModelCallsPart): void {
    this.modelCalls = modelCalls
  }

  // ─── Reads ───

  async list(authority: AppAuthority): Promise<AppSummary[]> {
    if (!mayUseApps(authority.principal)) return []
    const records = await listApps(recordScopeOf(authority.principal))
    const ids = records.map((record) => record.id)
    const lastCalls = await lastCallTimes(ids)
    const counts = await callCountsSince(ids, Date.now() - DAY_MS)
    return Promise.all(records.map((record) => appSummary(record, {
      lastCallAt: lastCalls.get(record.id) ?? null, calls24h: counts.get(record.id)?.calls ?? 0, failed24h: counts.get(record.id)?.failed ?? 0,
    })))
  }

  async read(authority: AppAuthority, idOrSlug: string): Promise<AppState> {
    return this.state(await this.app(authority, idOrSlug), authority)
  }

  /** The UI of the active version; null when the app has none. */
  async ui(authority: AppAuthority, idOrSlug: string): Promise<AppUi | null> {
    const app = await this.app(authority, idOrSlug)
    const version = await this.activeVersion(app)
    if (!version?.hasUi) return null
    const build = await this.build(app, version)
    if (build.ui === undefined) build.ui = (await this.deps.repositories.readFile(app.repository, version.buildCommit, UI_FILE))?.toString('utf8') ?? null
    return build.ui === null ? null : { version: version.number, html: build.ui }
  }

  async versions(authority: AppAuthority, idOrSlug: string): Promise<AppVersionView[]> {
    const app = await this.app(authority, idOrSlug)
    return (await listVersions(app.id)).map((version): AppVersionView => ({
      number: version.number,
      state: version.state,
      error: version.error,
      message: version.message,
      createdAt: version.createdAt,
      createdBy: version.createdBy,
      permissionsNotice: version.state === 'building' ? null : describeAppPermissions(version.descriptor.permissions, version.hasBackend),
      operationCount: version.descriptor.operations.length,
      hasUi: version.hasUi,
      revision: version.sourceCommit,
      protocol: version.descriptor.solusApp,
      buildMs: version.buildMs,
      activations: version.activations,
    }))
  }

  /** The app's revisions, the newest first, each with the versions built from it. */
  async revisions(authority: AppAuthority, idOrSlug: string): Promise<AppRevisionView[]> {
    const app = await this.app(authority, idOrSlug)
    const versions = await listVersions(app.id)
    return (await this.deps.repositories.revisions(app.repository)).map((revision): AppRevisionView => ({
      ...revision,
      versions: versions.filter((version) => version.sourceCommit === revision.commit).map((version) => version.number).sort((a, b) => a - b),
    }))
  }

  async versionDiff(authority: AppAuthority, idOrSlug: string, number: number): Promise<AppVersionDiff> {
    const app = await this.app(authority, idOrSlug)
    const version = await loadVersion(app.id, number)
    if (!version) throw new Error(`This app has no version ${number}.`)
    const before = number > 1 ? await loadVersion(app.id, number - 1) : null
    const { patch, truncated } = await this.deps.repositories.diff(app.repository, before?.sourceCommit ?? null, version.sourceCommit)
    return { version: number, base: before?.number ?? null, patch, truncated }
  }

  /** The source change of one revision: against the revision before it, or against `against` when a rollback compares two revisions. */
  async revisionDiff(authority: AppAuthority, idOrSlug: string, commit: string, against?: string): Promise<AppRevisionDiff> {
    const app = await this.app(authority, idOrSlug)
    for (const revision of against ? [commit, against] : [commit]) {
      if (!(await this.deps.repositories.hasRevision(app.repository, revision))) throw new Error('This app has no such revision.')
    }
    const base = against ?? await this.deps.repositories.parentOf(app.repository, commit)
    const { patch, truncated } = await this.deps.repositories.diff(app.repository, base, commit)
    return { commit, base, patch, truncated }
  }

  /** Where a step of a workflow is in the source of a version (the active one when `number` is absent); null when the source has no such step. */
  async stepSource(authority: AppAuthority, idOrSlug: string, request: { workflow: string; step: string; version?: number }): Promise<AppStepSource | null> {
    const app = await this.app(authority, idOrSlug)
    const version = request.version === undefined ? await this.requireActiveVersion(app) : await loadVersion(app.id, request.version)
    if (!version) throw new Error(`This app has no version ${request.version}.`)
    const { repositories } = this.deps
    const files = await readStepSourceFiles(await repositories.listFiles(app.repository, version.sourceCommit), (path) => repositories.readFile(app.repository, version.sourceCommit, path))
    const place = findStepPlace(files, request.workflow, request.step)
    const file = place && files.find((candidate) => candidate.path === place.path)
    return place && file ? { version: version.number, ...place, text: file.text } : null
  }

  async buildLog(authority: AppAuthority, idOrSlug: string, number: number): Promise<AppBuildLog> {
    const app = await this.app(authority, idOrSlug)
    const version = await loadVersion(app.id, number)
    if (!version) throw new Error(`This app has no version ${number}.`)
    return { version: number, log: version.buildLog ?? '', buildMs: version.buildMs }
  }

  async calls(authority: AppAuthority, idOrSlug: string, limit = 100, filter: AppCallFilter = {}): Promise<AppCallView[]> {
    const app = await this.app(authority, idOrSlug)
    return (await listCalls(app.id, limit, filter)).map(callView)
  }

  async callRead(authority: AppAuthority, idOrSlug: string, callId: string): Promise<AppCallDetail | null> {
    const app = await this.app(authority, idOrSlug)
    const call = await loadCall(app.id, callId)
    return call ? callDetail(call) : null
  }

  async metrics(authority: AppAuthority, idOrSlug: string): Promise<AppMetrics> {
    return appMetrics((await this.app(authority, idOrSlug)).id)
  }

  async callStats(authority: AppAuthority, idOrSlug: string, filter: AppCallFilter = {}): Promise<AppCallStats> {
    return appCallStats((await this.app(authority, idOrSlug)).id, filter)
  }

  async files(authority: AppAuthority, idOrSlug: string): Promise<AppFileView[]> {
    return this.deps.files.list((await this.app(authority, idOrSlug)).id)
  }

  async fileRemove(authority: AppAuthority, idOrSlug: string, fileId: string): Promise<AppFileView[]> {
    const app = await this.app(authority, idOrSlug)
    await this.deps.files.remove(app.id, fileId)
    return this.deps.files.list(app.id)
  }

  /**
   * Writes the source of a revision into a folder, so a session can change
   * the app: the newest revision, a named one, or the revision of a version.
   * The folder then names the app and that revision (decision 7).
   */
  async checkout(authority: AppAuthority, idOrSlug: string, folder: string, from: { version?: number; revision?: string } = {}): Promise<{ app: AppRecord; revision: string; files: number }> {
    const app = await this.app(authority, idOrSlug)
    let revision: string | null = from.revision ?? app.latestRevision
    if (from.version !== undefined) {
      const version = await loadVersion(app.id, from.version)
      if (!version) throw new Error(`This app has no version ${from.version}.`)
      revision = version.sourceCommit
    }
    if (!revision || !(await this.deps.repositories.hasRevision(app.repository, revision))) throw new Error('This app has no such revision.')
    const files = await this.deps.repositories.checkout(app.repository, revision, folder)
    await writeProjectOrigin(folder, { app: app.slug, revision })
    return { app, revision, files }
  }

  /** The running apps whose operations are tools for agents, each with what its active version declares. */
  async running(authority: AppAuthority): Promise<{ app: AppRecord; descriptor: AppDescriptor }[]> {
    if (!mayUseApps(authority.principal)) return []
    const running: { app: AppRecord; descriptor: AppDescriptor }[] = []
    for (const app of await listApps(recordScopeOf(authority.principal))) {
      const version = app.stopped || !app.agentAccess ? null : await this.activeVersion(app)
      if (version) running.push({ app, descriptor: version.descriptor })
    }
    return running
  }

  /** The record of an app the authority may use; for the parts of the host that hold an app's state. */
  async record(authority: AppAuthority, idOrSlug: string): Promise<AppRecord> {
    return this.app(authority, idOrSlug)
  }

  /** The record of an app by its id, for the host's own work: a schedule that is due names no person. */
  async hostRecord(appId: string): Promise<AppRecord | null> {
    return loadApp(ANY_ORGANIZATION, appId)
  }

  /** The app with what its runner runs, for the host's own work; null when it is stopped, gone, or has no version that runs. */
  async runnable(appId: string): Promise<AppRunnable | null> {
    const app = await loadApp(ANY_ORGANIZATION, appId)
    if (!app || app.stopped) return null
    const version = await this.activeVersion(app)
    return version?.hasBackend ? { app, version, run: await this.run(app, version) } : null
  }

  // ─── Save, deploy, and versions ───

  /**
   * Commits an app project's source as a new revision (decision 6). A save
   * changes nothing that runs. A project names the app and the revision it
   * came from (`.solus/app.json`); when the app has a newer revision now, the
   * save is refused (decision 7).
   */
  async save(authority: AppAuthority, input: AppSaveInput): Promise<AppSaveResult> {
    assertMayUse(authority.principal)
    const source = await readProjectSource(input.project)
    if (!source.some((file) => file.path === 'app.ts' || file.path === 'app.js')) throw new AppProjectError('This folder is not an app project: it has no app.ts next to package.json.')
    const { existing, expected } = await this.saveTarget(authority, input)
    const now = Date.now()
    const app = existing ?? await this.create(authority, input.name?.trim() || declaredName(source) || basename(input.project), input, now)
    const saved = await this.deps.repositories.saveRevision(app.repository, { source, message: input.message?.trim() || (existing ? 'Change the app' : 'First revision'), at: now, expected }).catch(async (error) => {
      // A new app whose first revision was not written is no app: its record and its repository go.
      if (!existing) {
        await deleteApp(app.id)
        await this.deps.repositories.remove(app.repository)
      }
      if (!(error instanceof AppRevisionConflict)) throw error
      throw new AppProjectError(`The app ${app.slug} has a newer revision (${short(error.newest ?? app.latestRevision)}) than the one this project came from (${short(expected)}). Another session saved it. Check the app out into a new folder with checkout_app, make your change there, and save that folder.`)
    })
    await saveApp({ ...app, latestRevision: saved.commit, updatedAt: now })
    await writeProjectOrigin(input.project, { app: app.slug, revision: saved.commit })
    log.info('app_saved', { appId: app.id, revision: saved.commit })
    const summary = await appSummaryOf(await this.reload(app.id))
    emitAppsChanged({ kind: 'saved', app: summary })
    return { app: summary, revision: saved.commit, created: existing === null, removed: saved.removed }
  }

  /**
   * The app a save is for, and the revision the project came from. A project
   * that names no app, and that no `app` names, makes a new one. A project of
   * an app that exists must be a checkout of it: a folder from anywhere else
   * would replace the app's source.
   */
  private async saveTarget(authority: AppAuthority, input: AppSaveInput): Promise<{ existing: AppRecord | null; expected: string | null }> {
    const origin = await readProjectOrigin(input.project)
    const named = input.app ?? origin?.app
    if (!named) return { existing: null, expected: null }
    const existing = await loadApp(recordScopeOf(authority.principal), named)
    if (!existing) {
      throw new AppProjectError(input.app
        ? `This host has no app named ${input.app}. Leave out \`app\` to make a new app.`
        : `This project is the app ${named}, which is not on this host. Delete .solus/app.json to save it as a new app.`)
    }
    if (!origin) {
      throw new AppProjectError(`This folder was not checked out from ${existing.slug}, so a save from it would replace the app's source. Check the app out into a new folder with checkout_app, make the change there, and save that folder.`)
    }
    if (origin.app !== existing.slug) {
      throw new AppProjectError(`This project is the app ${origin.app}, not ${existing.slug}. To change ${existing.slug}, check it out into a new folder with checkout_app.`)
    }
    return { existing, expected: origin.revision }
  }

  /**
   * Builds one revision on the host and makes the version active (decisions
   * 4 and 9). A version whose build fails, whose migrations are refused, or
   * whose backend does not start is recorded as failed, and the version
   * before it stays active.
   */
  async deploy(authority: AppAuthority, input: AppDeployInput): Promise<AppDeployResult> {
    const app = await this.app(authority, input.app)
    const revision = input.revision ?? app.latestRevision
    if (!revision || !(await this.deps.repositories.hasRevision(app.repository, revision))) throw new Error(input.revision ? 'This app has no such revision.' : 'This app has no revision. Save it first.')
    if ((await listVersions(app.id)).some((version) => version.state === 'building')) throw new Error('A build of this app is in progress. Wait for it to end.')
    const now = Date.now()
    const number = (await latestVersionNumber(app.id) ?? 0) + 1
    const message = (await this.deps.repositories.revisions(app.repository)).find((entry) => entry.commit === revision)?.message ?? ''
    const version: AppVersionRecord = {
      appId: app.id, number, sourceCommit: revision, buildCommit: '', descriptor: appDescriptorSchema.parse({ solusApp: APP_PROTOCOL, name: app.name }), hasBackend: false, hasUi: false,
      state: 'building', error: null, buildLog: null, buildMs: null, message, createdBy: input.createdBy, createdAt: now, activations: [],
    }
    await insertVersion(version)
    await this.announce(app.id)
    const failed = async (error: string, buildLog: string | null, buildMs: number | null): Promise<AppDeployResult> => {
      await failVersion(app.id, number, error, buildLog === null ? null : { log: buildLog, ms: buildMs })
      log.warn('app_version_failed', { appId: app.id, version: number, error })
      return { app: await this.announce(app.id), version: number, active: false, error, buildLog, permissionsNotice: null, secretsMissing: [] }
    }
    let built
    try {
      built = await this.deps.builder.buildRevision(app.id, async (folder) => {
        await this.deps.repositories.checkout(app.repository, revision, folder)
      })
    } catch (error) {
      if (error instanceof AppBuildError) return failed(error.message, error.log, error.ms)
      return failed(error instanceof Error ? error.message : String(error), null, null)
    }
    const { build } = built
    const trigger = build.descriptor.schedules.map(scheduleTriggerProblem).find((problem) => problem !== null)
    if (trigger) return failed(trigger, built.log, built.ms)
    version.buildCommit = await this.deps.repositories.commitBuild(app.repository, { number, revision, files: buildFiles(build), at: now })
    Object.assign(version, { descriptor: build.descriptor, hasBackend: build.backend !== null, hasUi: build.ui !== null, buildLog: built.log, buildMs: built.ms })
    await saveVersionBuild(version)
    this.builds.set(app.id, { version: number, backend: build.backend, migrations: build.migrations, ui: build.ui })
    const error = await this.makeActive(app, version, input.createdBy)
    if (error) {
      // The failed version's files must not answer for the version that still runs.
      this.builds.delete(app.id)
      return failed(error, null, null)
    }
    log.info('app_deployed', { appId: app.id, version: number, sessionId: input.sessionId ?? null })
    const summary = await appSummaryOf(await this.reload(app.id))
    emitAppsChanged(input.sessionId ? { kind: 'saved', app: summary, deployedBySessionId: input.sessionId } : { kind: 'saved', app: summary })
    const secrets = readAppSecrets(app.id)
    return {
      app: summary,
      version: number,
      active: true,
      error: null,
      buildLog: null,
      permissionsNotice: describeAppPermissions(build.descriptor.permissions, build.backend !== null),
      secretsMissing: build.descriptor.secrets.filter((secret) => !secrets[secret.name]).map((secret) => secret.name),
    }
  }

  /** Makes an earlier version active (decision 8). It does not rewind the app's data. */
  async activate(authority: AppAuthority, idOrSlug: string, number: number): Promise<AppState> {
    const app = await this.app(authority, idOrSlug)
    const version = await loadVersion(app.id, number)
    if (!version) throw new Error(`This app has no version ${number}.`)
    if (!version.buildCommit) throw new Error(`Version ${number} has no build: its build failed. Deploy its revision again.`)
    this.builds.delete(app.id)
    const { user } = authority.actor
    const error = await this.makeActive(app, version, user ? { kind: 'user', user } : hostAttribution())
    if (error) throw new Error(`Version ${number} did not start: ${error}`)
    return this.changed(app.id, authority)
  }

  async stop(authority: AppAuthority, idOrSlug: string): Promise<AppState> {
    const app = await this.app(authority, idOrSlug)
    await saveApp({ ...app, stopped: true, updatedAt: Date.now() })
    this.deps.runners.stop(app.id, 'This app is stopped.')
    return this.changed(app.id, authority)
  }

  async start(authority: AppAuthority, idOrSlug: string): Promise<AppState> {
    const app = await this.app(authority, idOrSlug)
    await saveApp({ ...app, stopped: false, updatedAt: Date.now() })
    // The runs that waited while the app was stopped start again.
    await this.workflows?.resume(app.id)
    return this.changed(app.id, authority)
  }

  /** Turns the app's operations as tools for agents off or on. A run that started before keeps the tools it has. */
  async setAgentAccess(authority: AppAuthority, idOrSlug: string, enabled: boolean): Promise<AppState> {
    const app = await this.app(authority, idOrSlug)
    await saveApp({ ...app, agentAccess: enabled, updatedAt: Date.now() })
    return this.changed(app.id, authority)
  }

  /**
   * What the owner calls the app and the colour of its tile. A field left out
   * stays; null clears it, so the app shows its manifest's name or description
   * again, or a colour from its id. A deploy never changes these.
   */
  async update(authority: AppAuthority, idOrSlug: string, patch: AppUpdate): Promise<AppState> {
    const app = await this.app(authority, idOrSlug)
    const customName = patch.name === undefined ? app.customName : ownerText(patch.name, app.name)
    const customDescription = patch.description === undefined ? app.customDescription : ownerText(patch.description, app.description)
    const colorHue = patch.colorHue === undefined ? app.colorHue : patch.colorHue
    await saveApp({ ...app, customName, customDescription, colorHue, updatedAt: Date.now() })
    return this.changed(app.id, authority)
  }

  /** Deletes the app with everything it kept on this host (§4.3). */
  async delete(authority: AppAuthority, idOrSlug: string): Promise<boolean> {
    const app = await this.app(authority, idOrSlug)
    this.deps.runners.stop(app.id, 'This app was deleted.')
    for (const part of this.lifecycle) await part.removed(app).catch((error) => log.warn('app_cleanup_failed', { appId: app.id, error: error instanceof Error ? error.message : String(error) }))
    const deleted = await deleteApp(app.id)
    this.builds.delete(app.id)
    clearTimeout(this.summaryTimers.get(app.id))
    this.summaryTimers.delete(app.id)
    forgetCallCounts(app.id)
    removeAppSecrets(app.id)
    await this.deps.storage.remove(app.id)
    await this.deps.builder.remove(app.id).catch(() => {})
    await this.deps.repositories.remove(app.repository)
    if (deleted) {
      emitAppsChanged({ kind: 'deleted', appId: app.id })
      log.info('app_deleted', { appId: app.id })
    }
    return deleted
  }

  /** Sets or clears one secret the active version declares. The runner starts again with the new values on its next call. */
  async secretSet(authority: AppAuthority, idOrSlug: string, name: string, value: string | null): Promise<AppState> {
    const app = await this.app(authority, idOrSlug)
    const declared = (await this.activeVersion(app))?.descriptor.secrets.some((secret) => secret.name === name)
    if (!declared && value !== null) throw new Error(`This app declares no secret named ${name}.`)
    writeAppSecret(app.id, name, value)
    return this.changed(app.id, authority)
  }

  /**
   * Sets one config value of a field the active version declares, or gives it
   * its default again with `null`. The runner starts again with the new values
   * on its next call, and every open UI reads the config and its queries again.
   */
  async configSet(authority: AppAuthority, idOrSlug: string, name: string, value: AppConfigValue | null): Promise<AppState> {
    const app = await this.app(authority, idOrSlug)
    const field = (await this.activeVersion(app))?.descriptor.config.find((declared) => declared.name === name)
    if (!field && value !== null) throw new Error(`This app has no config field named ${name}.`)
    const problem = field && value !== null ? appConfigValueProblem(field, value) : null
    if (problem) throw new Error(problem)
    await this.deps.storage.setConfig(app.id, name, value)
    log.info('app_config_set', { appId: app.id, name, reset: value === null })
    emitAppDataChanged(app.id)
    return this.changed(app.id, authority)
  }

  // ─── Calls ───

  /** One call of the app's UI (§5): an operation, its storage, its files, or an integration tool. Answers `{ value }` as JSON text. */
  async call(authority: AppAuthority, idOrSlug: string, name: string, argumentsJson: string, identity: AppUiIdentity = uiIdentityOf(authority)): Promise<string> {
    const app = await this.app(authority, idOrSlug)
    const target = parseAppCallName(name)
    if (!target) throw new Error(`This app cannot call ${name}.`)
    if (target.kind === 'client') throw new Error(`${name} is answered by the client that shows the app, not by its host.`)
    const input = inputSchema.parse(JSON.parse(argumentsJson))
    let value: StoredValue
    if (target.kind === 'storage') value = await this.runStorage(app.id, target.operation, input)
    else if (target.kind === 'config') value = await this.configOf(app.id, (await this.activeVersion(app))?.descriptor ?? null)
    else if (target.kind === 'files') value = await this.deps.files.call(app.id, target.operation, input, 'ui')
    else if (target.kind === 'models') value = await this.requireModelCalls().uiCall(app, target.operation, input)
    else if (target.kind === 'operation') value = await this.runOperation(app, target.name, input, { kind: 'ui', ...identity }, authority)
    else if (this.deps.remoteTools) value = await this.deps.remoteTools.call({ slug: target.slug, tool: target.tool, input })
    else value = await this.integrationCalls.call(app, await this.requireActiveVersion(app), target.slug, target.tool, input, authority)
    return JSON.stringify({ value })
  }

  /**
   * One call of an operation for a caller that is not the UI: an agent, a
   * schedule, a webhook, or a workflow's step. The host's own work has no
   * authority of its own and acts as the app's owner.
   */
  async callOperation(appId: string, operation: string, input: StoredValue, caller: AppCaller, authority: AppAuthority | null): Promise<StoredValue> {
    const app = authority ? await this.app(authority, appId) : await this.reload(appId)
    return this.runOperation(app, operation, input, caller, authority)
  }

  /**
   * What an app's code asks the host for, outside a step's receipts: an
   * integration tool, an app file's record, or a workflow control. A call
   * with no authority (a schedule, a webhook, a workflow) acts as the owner.
   */
  async hostRequest(app: AppRecord, version: AppVersionRecord, method: string, input: StoredValue, caller: AppCaller, authority: AppAuthority | null = null): Promise<StoredValue> {
    switch (method) {
      case 'tool': {
        const request = toolRequestSchema.parse(input)
        if (this.deps.remoteTools) return this.deps.remoteTools.call({ slug: request.slug, tool: request.tool, input: inputSchema.parse(request.input) })
        return this.integrationCalls.call(app, version, request.slug, request.tool, inputSchema.parse(request.input), authority)
      }
      case 'files.list':
        return (await this.deps.files.list(app.id)).map((file) => ({ ...file }))
      case 'files.get': {
        const file = await this.deps.files.get(app.id, fileIdSchema.parse(input).id)
        return file ? { ...file } : null
      }
      case 'files.add':
        return { ...(await this.deps.files.add(app.id, input, caller.kind)) }
      case 'files.remove':
        await this.deps.files.remove(app.id, fileIdSchema.parse(input).id)
        return null
      case 'workflows.start': {
        const request = workflowStartSchema.parse(input)
        return { ...(await this.requireWorkflows().startRun(app, version.descriptor, request.workflow, request.input, request.key, caller)) }
      }
      case 'workflows.get': {
        const run = await this.requireWorkflows().getRun(app, workflowRunSchema.parse(input).runId)
        return run ? { ...run } : null
      }
      case 'workflows.list':
        return (await this.requireWorkflows().listRunFaces(app, workflowListSchema.parse(input))).map((run) => ({ ...run }))
      case 'workflows.terminate':
        return { ...(await this.requireWorkflows().terminateRun(app, workflowRunSchema.parse(input).runId)) }
      default:
        if (method.startsWith('models.')) return this.requireModelCalls().hostRequest(app, version.descriptor, await this.configOf(app.id, version.descriptor), method, input, caller)
        throw new Error(`The host does not answer ${method} here.`)
    }
  }

  /** Gives the signals of a workflow step that succeeded to their signal actions. */
  async signalsEmitted(app: AppRecord, descriptor: AppDescriptor, signals: readonly AppArrivedSignal[], runId: string): Promise<void> {
    await this.signals?.emitted(app, descriptor, signals, { callId: null, runId })
  }

  /** A run finished, ran again, or was dismissed: what needs the owner can differ, so every client reads the summary again. */
  runsChanged(appId: string): void {
    // The app can be gone by now.
    void this.announce(appId).catch(() => {})
  }

  /**
   * What answers an app UI's calls while an agent previews a project (§7.2);
   * the frame's network hosts are the project's own. A preview changes
   * nothing: storage and files are in memory, an operation runs against a new
   * database with the project's migrations, no secret, and the default of
   * each config field, and no integration is called.
   */
  async previewHost(authority: AppAuthority, build: AppBuild, scratch: { appFolder: string; filesDir: string }): Promise<{ host: AppPreviewHost; dispose(): void }> {
    assertMayUse(authority.principal)
    const previewId = `preview-${randomUUID()}`
    const written = new Map<string, AppPreviewValue>()
    const backend = build.backend
    const run: AppRun | null = backend === null ? null : {
      appId: previewId, signature: 'preview', code: backend, protocol: build.descriptor.solusApp, permissions: build.descriptor.permissions, ...scratch,
      secrets: {}, config: resolveAppConfig(build.descriptor.config, {}), migrations: build.migrations, operations: operationKinds(build.descriptor), workflows: build.descriptor.workflows.map((workflow) => workflow.name),
    }
    const refuse = (what: string) => Promise.reject(new Error(`A preview does not ${what}.`))
    const host: AppRunnerHost = {
      log: () => {},
      span: () => {},
      request: (method) => refuse(method === 'tool' ? 'call an integration' : method.startsWith('files.') ? 'keep an app file' : method.startsWith('models.') ? 'call a model' : 'start a workflow'),
    }
    const call = async (name: string, input: AppPreviewArguments): Promise<AppPreviewValue> => {
      const target = parseAppCallName(name)
      if (target?.kind === 'storage') {
        if (target.operation === 'set') written.set(storageSetSchema.parse(input).key, storageSetSchema.parse(input).value)
        if (target.operation === 'delete') written.delete(storageKeySchema.parse(input).key)
        if (target.operation === 'keys') return [...written.keys()]
        return target.operation === 'get' ? written.get(storageKeySchema.parse(input).key) ?? null : null
      }
      // A first open has no app file, and a preview takes none.
      if (target?.kind === 'files') return target.operation === 'list' ? [] : refuse('keep an app file')
      if (target?.kind === 'client') return null
      // A preview runs with each field's default.
      if (target?.kind === 'config') return resolveAppConfig(build.descriptor.config, {})
      if (target?.kind === 'operation') {
        if (!run) throw new Error('This app has no backend.')
        return (await this.deps.runners.call(run, { name: target.name, input, caller: { kind: 'ui' }, host })).value
      }
      throw new Error(previewRefusal(name, target))
    }
    return { host: { network: build.descriptor.permissions.network, call }, dispose: () => this.deps.runners.stop(previewId) }
  }

  // ─── Inside ───

  /** The app in the authority's scope: another scope's id does not resolve, and only the host's owner uses an app. */
  private async app(authority: AppAuthority, idOrSlug: string): Promise<AppRecord> {
    assertMayUse(authority.principal)
    const app = await loadApp(recordScopeOf(authority.principal), idOrSlug)
    if (!app) throw new Error(APP_UNAVAILABLE)
    return app
  }

  private async reload(appId: string): Promise<AppRecord> {
    // The host reads its own record by id, whatever organization it is in.
    const app = await loadApp(ANY_ORGANIZATION, appId)
    if (!app) throw new Error(APP_UNAVAILABLE)
    return app
  }

  private requireWorkflows(): AppWorkflowControls {
    if (!this.workflows) throw new Error('This host does not run workflows.')
    return this.workflows
  }

  private requireModelCalls(): AppModelCallsPart {
    if (!this.modelCalls) throw new Error('This host does not run model calls.')
    return this.modelCalls
  }

  private async activeVersion(app: AppRecord): Promise<AppVersionRecord | null> {
    return app.activeVersion === null ? null : loadVersion(app.id, app.activeVersion)
  }

  private async requireActiveVersion(app: AppRecord): Promise<AppVersionRecord> {
    const version = await this.activeVersion(app)
    if (!version) throw new Error('This app has no version that runs. Deploy it.')
    return version
  }

  /** A new app from its first save: an id, a slug nothing else on the host has, and a repository. */
  private async create(authority: AppAuthority, name: string, input: AppSaveInput, now: number): Promise<AppRecord> {
    const id = randomUUID()
    const organizationId = organizationForNew(authority.principal)
    // The host's own work (an automation's run) saves for the host's user.
    const ownerKey = ownerKeyOf(authority.actor) ?? hostUserKey()
    const record: AppRecord = {
      id, organizationId, ownerKey,
      slug: await this.freeSlug(appSlugOf(name), recordScopeOf(authority.principal), ownerKey),
      name: name.slice(0, 80), description: '', customName: null, customDescription: null, colorHue: null, activeVersion: null, stopped: false, agentAccess: true,
      repository: this.deps.repositories.nameFor(organizationId, id), latestRevision: null, project: input.project, createdBy: input.createdBy,
      webhookIds: {}, createdAt: now, updatedAt: now,
    }
    await insertApp(record)
    return record
  }

  /** A slug that no app on the host has and that is not one of the owner's integrations or a built-in connection: each is `tools.<slug>`. */
  private async freeSlug(wanted: string, scope: RecordScope, ownerKey: string): Promise<string> {
    const taken = async (slug: string) => isConnectionProvider(slug) || await slugIsTaken(slug) || this.deps.integrations.getBySlug(slug, scope, ownerKey) !== null
    if (!(await taken(wanted))) return wanted
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const slug = `${wanted.slice(0, 44)}-${suffix}`
      if (!(await taken(slug))) return slug
    }
    throw new Error(`This host has too many apps named ${wanted}.`)
  }

  /** Starts a version and makes it the active one. Answers why it did not start, or null. */
  private async makeActive(app: AppRecord, version: AppVersionRecord, by: Attribution): Promise<string | null> {
    try {
      if (version.hasBackend) await this.deps.runners.start(await this.run(app, version))
      else this.deps.runners.stop(app.id, 'The app changed. Call it again.')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await failVersion(app.id, version.number, reason)
      return reason
    }
    const current = await this.reload(app.id)
    await activateVersion({ ...current, name: version.descriptor.name, description: version.descriptor.description, updatedAt: Date.now() }, version.number, by)
    const active = await this.reload(app.id)
    for (const part of this.lifecycle) await part.activated(active, version.descriptor).catch((error) => log.warn('app_lifecycle_failed', { appId: app.id, error: error instanceof Error ? error.message : String(error) }))
    return null
  }

  /**
   * What a deployment gets of the app (docs/plans/app-deploy.md §5): the
   * build that this Solus made of the active version (decision 6), the config
   * the app runs with here, and the values of the secrets it declares.
   */
  async published(authority: AppAuthority, idOrSlug: string): Promise<{ app: AppRecord; push: AppVersionPush; secrets: AppSecretValues }> {
    const app = await this.app(authority, idOrSlug)
    const version = await this.requireActiveVersion(app)
    const build = await this.build(app, version)
    const ui = version.hasUi ? (await this.deps.repositories.readFile(app.repository, version.buildCommit, UI_FILE))?.toString('utf8') ?? null : null
    return {
      app,
      secrets: await this.declaredSecrets(app),
      push: {
        app: { id: app.id, slug: app.slug },
        number: version.number,
        sourceCommit: version.sourceCommit,
        message: version.message,
        build: { descriptor: version.descriptor, backend: build.backend, ui, migrations: build.migrations },
        config: await this.configOf(app.id, version.descriptor),
      },
    }
  }

  private async build(app: AppRecord, version: AppVersionRecord): Promise<LoadedBuild> {
    const kept = this.builds.get(app.id)
    if (kept?.version === version.number) return kept
    const { repositories } = this.deps
    const backend = version.hasBackend ? (await repositories.readFile(app.repository, version.buildCommit, BACKEND_FILE))?.toString('utf8') ?? null : null
    const names = (await repositories.listFiles(app.repository, version.buildCommit, MIGRATIONS_FOLDER)).sort()
    const migrations: AppMigration[] = []
    for (const path of names) {
      const sql = await repositories.readFile(app.repository, version.buildCommit, path)
      if (sql) migrations.push({ name: path.slice(MIGRATIONS_FOLDER.length + 1), sql: sql.toString('utf8') })
    }
    const build: LoadedBuild = { version: version.number, backend, migrations, ui: undefined }
    this.builds.set(app.id, build)
    return build
  }

  /** What the app's runner runs for a version. Its signature changes with the version, the secrets, and the config. */
  private async run(app: AppRecord, version: AppVersionRecord): Promise<AppRun> {
    const build = await this.build(app, version)
    if (build.backend === null) throw new Error('This app has no backend.')
    const secrets = readAppSecrets(app.id)
    const declared = Object.fromEntries(version.descriptor.secrets.flatMap((secret) => (secrets[secret.name] ? [[secret.name, secrets[secret.name]]] : [])))
    const config = await this.configOf(app.id, version.descriptor)
    return {
      appId: app.id,
      signature: `${version.number}:${createHash('sha256').update(JSON.stringify([declared, config])).digest('hex').slice(0, 16)}`,
      code: build.backend,
      protocol: version.descriptor.solusApp,
      permissions: version.descriptor.permissions,
      ...(await this.deps.storage.folders(app.id)),
      secrets: declared,
      config,
      migrations: build.migrations,
      operations: operationKinds(version.descriptor),
      workflows: version.descriptor.workflows.map((workflow) => workflow.name),
    }
  }

  /** Runs one operation for one caller and writes the call log (§5). */
  private async runOperation(app: AppRecord, operation: string, input: StoredValue, caller: AppCaller, authority: AppAuthority | null): Promise<StoredValue> {
    if (app.stopped) throw new Error('This app is stopped. Start it on its Manage page.')
    const version = await this.requireActiveVersion(app)
    const declared = version.descriptor.operations.find((entry) => entry.name === operation)
    if (!declared) throw new Error(`This app has no operation named ${operation}.`)
    const recording = await beginCall({ app, version: version.number, operation, operationKind: declared.kind, caller, input, runId: caller.kind === 'workflow' ? caller.runId : null })
    try {
      const result = await this.deps.runners.call(await this.run(app, version), {
        name: operation,
        input,
        caller,
        timeoutMs: declared.timeoutSeconds === undefined ? undefined : declared.timeoutSeconds * 1000,
        host: { log: recording.log, span: recording.span, request: (method, request) => this.hostRequest(app, version, method, request, caller, authority) },
      })
      await recording.succeeded(result.value)
      this.summarySoon(app.id)
      if (result.changed) emitAppDataChanged(app.id)
      await this.signals?.emitted(app, version.descriptor, result.signals, { callId: recording.id, runId: caller.kind === 'workflow' ? caller.runId : null })
      return result.value
    } catch (error) {
      await recording.failed(error instanceof Error ? error : new Error(String(error)))
      this.summarySoon(app.id)
      // A mutation that failed may have written before it failed.
      if (error instanceof AppOperationError && error.changed) emitAppDataChanged(app.id)
      throw error
    }
  }

  /** The config the app runs with: the owner's values that the declaration takes, and the defaults. Empty with no active version. */
  private async configOf(appId: string, descriptor: AppDescriptor | null): Promise<{ [name: string]: AppConfigValue }> {
    return descriptor ? resolveAppConfig(descriptor.config, await this.deps.storage.config(appId)) : {}
  }

  /** The values of the secrets that the active version declares and the owner gave. */
  private async declaredSecrets(app: AppRecord): Promise<AppSecretValues> {
    const secrets = readAppSecrets(app.id)
    const declared = (await this.activeVersion(app))?.descriptor.secrets ?? []
    return Object.fromEntries(declared.flatMap((secret) => (secrets[secret.name] ? [[secret.name, secrets[secret.name]]] : [])))
  }

  private async runStorage(appId: string, operation: AppStorageOperation, input: CallInput): Promise<StoredValue> {
    const { storage } = this.deps
    switch (operation) {
      case 'get':
        return storage.get(appId, storageKeySchema.parse(input).key)
      case 'keys':
        return storage.keys(appId)
      case 'set': {
        const { key, value } = storageSetSchema.parse(input)
        await storage.set(appId, key, value)
        return null
      }
      case 'delete':
        await storage.delete(appId, storageKeySchema.parse(input).key)
        return null
    }
  }

  /** The state after a change, announced to every client. */
  private async changed(appId: string, authority: AppAuthority): Promise<AppState> {
    const app = await this.reload(appId)
    const state = await this.state(app, authority)
    emitAppsChanged({ kind: 'saved', app: state.app })
    return state
  }

  /**
   * A call changes what a list says of an app: its last call and its calls of
   * 24 hours. A busy app is called many times, so the host says the summary
   * again once, some seconds after the first call that it has not said.
   */
  private summarySoon(appId: string): void {
    if (this.summaryTimers.has(appId)) return
    const timer = setTimeout(() => {
      this.summaryTimers.delete(appId)
      // The app can be gone by now.
      void this.announce(appId).catch(() => {})
    }, SUMMARY_AFTER_CALL_MS)
    timer.unref?.()
    this.summaryTimers.set(appId, timer)
  }

  /** Says the app's summary to every client, and answers it. */
  private async announce(appId: string): Promise<AppSummary> {
    const summary = await appSummaryOf(await this.reload(appId))
    emitAppsChanged({ kind: 'saved', app: summary })
    return summary
  }

  private async state(app: AppRecord, authority: AppAuthority): Promise<AppState> {
    const version = await this.activeVersion(app)
    const secrets = readAppSecrets(app.id)
    const config = await this.configOf(app.id, version?.descriptor ?? null)
    return {
      app: await appSummaryOf(app),
      descriptor: version?.descriptor ?? null,
      roles: version ? await this.integrationCalls.roles(app, version.descriptor, authority) : [],
      secrets: (version?.descriptor.secrets ?? []).map((secret) => ({ ...secret, isSet: Boolean(secrets[secret.name]) })),
      config: (version?.descriptor.config ?? []).map((field) => ({ ...field, value: config[field.name] ?? field.default, isDefault: config[field.name] === field.default })),
      network: version?.descriptor.permissions.network ?? [],
      permissionsNotice: version ? describeAppPermissions(version.descriptor.permissions, version.hasBackend) : null,
      runtime: this.deps.runners.status(app.id),
      repositoryPath: this.deps.repositories.path(app.repository),
    }
  }

}

function operationKinds(descriptor: AppDescriptor): AppRun['operations'] {
  return descriptor.operations.map(({ name, kind }) => ({ name, kind }))
}

/** Only the host's owner uses an app in this release (decision 12); the host's own work acts for them. */
export function mayUseApps(principal: Principal): boolean {
  return principal.kind === 'system' || isHostOwner(principal)
}

function assertMayUse(principal: Principal): void {
  if (!mayUseApps(principal)) throw new Error('Only the owner of this host can use its apps.')
}
