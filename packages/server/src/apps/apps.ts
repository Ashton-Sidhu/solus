import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  appSlugOf,
  describeAppPermissions,
  parseAppCallName,
  type AppAttention,
  type AppCallView,
  type AppCaller,
  type AppDescriptor,
  type AppRoleState,
  type AppState,
  type AppStorageOperation,
  type AppSummary,
  type AppUi,
  type AppVersionDiff,
  type AppVersionView,
} from '@solus/contracts/apps'
import type { Integration } from '@solus/contracts/integration-types'
import type { Attribution } from '@solus/contracts/user'
import { ownerKeyOf, type Actor } from '../admission/actor'
import { ANY_ORGANIZATION, isHostOwner, organizationForNew, recordScopeOf, type Principal, type RecordScope } from '../admission/principal'
import {
  activateVersion,
  deleteApp,
  failVersion,
  finishCall,
  insertApp,
  insertCall,
  insertVersion,
  lastCallTimes,
  latestVersionNumber,
  listApps,
  listCalls,
  listSchedules,
  listVersions,
  loadApp,
  loadVersion,
  pruneCalls,
  saveApp,
  slugIsTaken,
  type AppRecord,
  type AppVersionRecord,
} from '../data/apps/app-store'
import type { AppPreviewArguments, AppPreviewHost, AppPreviewValue } from '../data/works/artifact-preview'
import type { IntegrationGateway } from '../integrations/gateway'
import type { IntegrationStore } from '../integrations/integration-store'
import { hostUserKey } from '../host/host-user'
import { createLogger } from '../logger'
import { withUserScope } from '../vault/acting-scope'
import { emitAppDataChanged, emitAppsChanged } from './app-events'
import { BACKEND_FILE, MIGRATIONS_FOLDER, UI_FILE, buildFiles, readAppBuild, readProjectSource, type AppBuild, type AppMigration } from './app-project'
import type { AppRepositories } from './app-repository'
import { AppOperationError, type AppRun, type AppRunners } from './app-runners'
import { readAppSecrets, removeAppSecrets, writeAppSecret } from './app-secrets'
import type { AppStorage, StoredValue } from './app-storage'

const log = createLogger('apps', 'apps.ts')

const APP_UNAVAILABLE = 'This app is not available.'
const PRUNE_EVERY_CALLS = 100

const inputSchema = z.record(z.string(), z.json())
type CallInput = z.infer<typeof inputSchema>
const storageKeySchema = z.object({ key: z.string() })
const storageSetSchema = storageKeySchema.extend({ value: z.json() })

/** A tool result as an integration answers it. */
const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.json().optional(),
  isError: z.boolean().optional(),
})

/** Who asks. The host's own work (a schedule, a webhook) has the system principal and acts as the app's owner. */
export interface AppAuthority {
  principal: Principal
  actor: Actor
}

/** What a part of the host does when an app's active version changes, or the app goes: its schedules and its webhooks. */
export interface AppLifecyclePart {
  activated(app: AppRecord, descriptor: AppDescriptor): Promise<void>
  removed(app: AppRecord): Promise<void>
}

export interface AppDeployInput {
  /** The app project: a folder with a build in `dist/app/`. */
  project: string
  /** The app a new version is for, by id or slug; absent for a new app. */
  app?: string
  message?: string
  createdBy: Attribution
  /** The session whose agent deploys, so its conversation can open the app. */
  sessionId?: string | null
}

export interface AppDeployResult {
  app: AppSummary
  version: number
  /** False when the version did not start: the version before it still runs. */
  active: boolean
  error: string | null
  created: boolean
  permissionsNotice: string | null
  /** The declared secrets that have no value yet. */
  secretsMissing: string[]
}

export interface AppsDeps {
  gateway: Pick<IntegrationGateway, 'callAppTool' | 'toolsFor' | 'connectionStatus'>
  integrations: Pick<IntegrationStore, 'getBySlug'>
  storage: AppStorage
  runners: AppRunners
  repositories: AppRepositories
  /** Runs an integration call as a person, for a caller with no person of its own. `withUserScope` on a host. */
  runAs?: <T>(personKey: string | null, run: () => T) => T
}

/** The files of one version that a host reads more than once. */
interface LoadedBuild {
  version: number
  backend: string | null
  migrations: AppMigration[]
  ui: string | null | undefined
}

/**
 * Apps (docs/plans/apps.md §10): the one owner of an app's versions and of
 * every call of its operations. Its UI, an agent, a schedule, and a webhook
 * all enter through `callOperation`. An app is its host owner's in this
 * release, so every entry checks that first.
 */
export class Apps {
  private readonly builds = new Map<string, LoadedBuild>()
  private readonly lifecycle: AppLifecyclePart[] = []
  private readonly callCounts = new Map<string, number>()

  constructor(private readonly deps: AppsDeps) {}

  /** Installed once at boot: the schedules and the webhooks of an app follow its active version. */
  addLifecyclePart(part: AppLifecyclePart): void {
    this.lifecycle.push(part)
  }

  // ─── Reads ───

  async list(authority: AppAuthority): Promise<AppSummary[]> {
    if (!mayUseApps(authority.principal)) return []
    const records = await listApps(recordScopeOf(authority.principal))
    const calls = await lastCallTimes(records.map((record) => record.id))
    return Promise.all(records.map((record) => this.summary(record, calls.get(record.id) ?? null)))
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
      permissionsNotice: describeAppPermissions(version.descriptor.permissions, version.hasBackend),
      operationCount: version.descriptor.operations.length,
      hasUi: version.hasUi,
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

  async calls(authority: AppAuthority, idOrSlug: string, limit = 100): Promise<AppCallView[]> {
    const app = await this.app(authority, idOrSlug)
    return (await listCalls(app.id, limit)).map((call): AppCallView => ({
      id: call.id, version: call.version, operation: call.operation, caller: call.caller,
      startedAt: call.startedAt, finishedAt: call.finishedAt, outcome: call.outcome, error: call.error,
    }))
  }

  /** Writes the source of a version into a folder, so a session can change the app. */
  async checkout(authority: AppAuthority, idOrSlug: string, folder: string, number?: number): Promise<{ app: AppRecord; version: number; files: number }> {
    const app = await this.app(authority, idOrSlug)
    const version = number === undefined ? (await listVersions(app.id))[0] : await loadVersion(app.id, number)
    if (!version) throw new Error(number === undefined ? 'This app has no version yet.' : `This app has no version ${number}.`)
    return { app, version: version.number, files: await this.deps.repositories.checkout(app.repository, version.sourceCommit, folder) }
  }

  /** Where the app's repository is on this host. */
  async repositoryPath(authority: AppAuthority, idOrSlug: string): Promise<string> {
    return this.deps.repositories.path((await this.app(authority, idOrSlug)).repository)
  }

  /** The apps that run now, each with what its active version declares: what an agent's tools are made from. */
  async running(authority: AppAuthority): Promise<{ app: AppRecord; descriptor: AppDescriptor }[]> {
    if (!mayUseApps(authority.principal)) return []
    const running: { app: AppRecord; descriptor: AppDescriptor }[] = []
    for (const app of await listApps(recordScopeOf(authority.principal))) {
      const version = app.stopped ? null : await this.activeVersion(app)
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

  // ─── Deploy and versions ───

  /**
   * Makes a version from an app project (§4.2) and makes it active. A version
   * whose backend does not start is recorded as failed, and the version
   * before it stays active.
   */
  async deploy(authority: AppAuthority, input: AppDeployInput): Promise<AppDeployResult> {
    assertMayUse(authority.principal)
    const build = await readAppBuild(input.project)
    const source = await readProjectSource(input.project)
    const existing = input.app ? await loadApp(recordScopeOf(authority.principal), input.app) : null
    if (input.app && !existing) throw new Error(`This host has no app named ${input.app}. Leave out \`app\` to make a new app.`)
    const now = Date.now()
    const app = existing ?? await this.create(authority, build.descriptor, input, now)
    const number = (await latestVersionNumber(app.id) ?? 0) + 1
    const commits = await this.deps.repositories.commitVersion(app.repository, {
      number, source, build: buildFiles(build), message: input.message?.trim() || `Version ${number}`, at: now,
    })
    const version: AppVersionRecord = {
      appId: app.id, number, ...commits, descriptor: build.descriptor, hasBackend: build.backend !== null, hasUi: build.ui !== null,
      state: 'failed', error: null, message: input.message?.trim() ?? '', createdBy: input.createdBy, createdAt: now,
    }
    await insertVersion(version)
    this.builds.set(app.id, { version: number, backend: build.backend, migrations: build.migrations, ui: build.ui })
    const error = await this.makeActive(app, version)
    if (error) {
      // The failed version's files must not answer for the version that still runs.
      this.builds.delete(app.id)
      log.warn('app_version_failed', { appId: app.id, version: number, error })
    } else {
      log.info('app_deployed', { appId: app.id, version: number, sessionId: input.sessionId ?? null })
    }
    const saved = await this.reload(app.id)
    const summary = await this.summary(saved, null)
    emitAppsChanged(input.sessionId ? { kind: 'saved', app: summary, deployedBySessionId: input.sessionId } : { kind: 'saved', app: summary })
    const secrets = readAppSecrets(app.id)
    return {
      app: summary,
      version: number,
      active: error === null,
      error,
      created: existing === null,
      permissionsNotice: describeAppPermissions(build.descriptor.permissions, build.backend !== null),
      secretsMissing: build.descriptor.secrets.filter((secret) => !secrets[secret.name]).map((secret) => secret.name),
    }
  }

  /** Makes an earlier version active (§2 decision 6). It does not rewind the app's data. */
  async activate(authority: AppAuthority, idOrSlug: string, number: number): Promise<AppState> {
    const app = await this.app(authority, idOrSlug)
    const version = await loadVersion(app.id, number)
    if (!version) throw new Error(`This app has no version ${number}.`)
    this.builds.delete(app.id)
    const error = await this.makeActive(app, version)
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
    return this.changed(app.id, authority)
  }

  /** Deletes the app with everything it kept on this host (§4.3). */
  async delete(authority: AppAuthority, idOrSlug: string): Promise<boolean> {
    const app = await this.app(authority, idOrSlug)
    this.deps.runners.stop(app.id, 'This app was deleted.')
    for (const part of this.lifecycle) await part.removed(app).catch((error) => log.warn('app_cleanup_failed', { appId: app.id, error: error instanceof Error ? error.message : String(error) }))
    const deleted = await deleteApp(app.id)
    this.builds.delete(app.id)
    this.callCounts.delete(app.id)
    removeAppSecrets(app.id)
    await this.deps.storage.remove(app.id)
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

  // ─── Calls ───

  /** One call of the app's UI (§5): an operation, its storage, or an integration tool. Answers `{ value }` as JSON text. */
  async call(authority: AppAuthority, idOrSlug: string, name: string, argumentsJson: string): Promise<string> {
    const app = await this.app(authority, idOrSlug)
    const target = parseAppCallName(name)
    if (!target) throw new Error(`This app cannot call ${name}.`)
    const input = inputSchema.parse(JSON.parse(argumentsJson))
    let value: StoredValue
    if (target.kind === 'storage') value = await this.runStorage(app.id, target.operation, input)
    else if (target.kind === 'operation') value = await this.runOperation(app, target.name, input, { kind: 'ui' }, authority)
    else value = await this.callIntegration(app, await this.requireActiveVersion(app), target.slug, target.tool, input, authority)
    return JSON.stringify({ value })
  }

  /**
   * One call of an operation for a caller that is not the UI: an agent, a
   * schedule, or a webhook. A schedule and a webhook have no authority of
   * their own and act as the app's owner.
   */
  async callOperation(appId: string, operation: string, input: StoredValue, caller: AppCaller, authority: AppAuthority | null): Promise<StoredValue> {
    const app = authority ? await this.app(authority, appId) : await this.reload(appId)
    return this.runOperation(app, operation, input, caller, authority)
  }

  /**
   * What answers an app UI's calls while an agent previews a project (§7.2);
   * the frame's network hosts are the project's own. A preview changes
   * nothing: storage is in memory, an operation runs against a new database
   * with the project's migrations and no secret, and no integration is called.
   */
  async previewHost(authority: AppAuthority, build: AppBuild, scratch: { appFolder: string; filesDir: string }): Promise<{ host: AppPreviewHost; dispose(): void }> {
    assertMayUse(authority.principal)
    const previewId = `preview-${randomUUID()}`
    const written = new Map<string, AppPreviewValue>()
    const backend = build.backend
    const run: AppRun | null = backend === null ? null : {
      appId: previewId, signature: 'preview', code: backend, permissions: build.descriptor.permissions, ...scratch,
      secrets: {}, migrations: build.migrations, operations: operationKinds(build.descriptor),
    }
    const call = async (name: string, input: AppPreviewArguments): Promise<AppPreviewValue> => {
      const target = parseAppCallName(name)
      if (target?.kind === 'storage') {
        if (target.operation === 'set') written.set(storageSetSchema.parse(input).key, storageSetSchema.parse(input).value)
        if (target.operation === 'delete') written.delete(storageKeySchema.parse(input).key)
        if (target.operation === 'keys') return [...written.keys()]
        return target.operation === 'get' ? written.get(storageKeySchema.parse(input).key) ?? null : null
      }
      if (target?.kind === 'operation') {
        if (!run) throw new Error('This app has no backend.')
        return (await this.deps.runners.call(run, { name: target.name, input, caller: { kind: 'ui' }, tools: () => Promise.reject(new Error('A preview does not call an integration.')) })).value
      }
      throw new Error(target ? 'A preview does not call an integration.' : `A preview cannot call ${name}.`)
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

  private async activeVersion(app: AppRecord): Promise<AppVersionRecord | null> {
    return app.activeVersion === null ? null : loadVersion(app.id, app.activeVersion)
  }

  private async requireActiveVersion(app: AppRecord): Promise<AppVersionRecord> {
    const version = await this.activeVersion(app)
    if (!version) throw new Error('This app has no version that runs. Deploy it again.')
    return version
  }

  /** A new app from its first build: an id, a slug nothing else on the host has, and a repository. */
  private async create(authority: AppAuthority, descriptor: AppDescriptor, input: AppDeployInput, now: number): Promise<AppRecord> {
    const id = randomUUID()
    const organizationId = organizationForNew(authority.principal)
    // The host's own work (an automation's run) deploys for the host's user.
    const ownerKey = ownerKeyOf(authority.actor) ?? hostUserKey()
    const record: AppRecord = {
      id, organizationId, ownerKey,
      slug: await this.freeSlug(appSlugOf(descriptor.name), recordScopeOf(authority.principal), ownerKey),
      name: descriptor.name, description: descriptor.description, activeVersion: null, stopped: false,
      repository: this.deps.repositories.nameFor(organizationId, id), project: input.project, createdBy: input.createdBy,
      webhookIds: {}, createdAt: now, updatedAt: now,
    }
    await insertApp(record)
    return record
  }

  /** A slug that no app on the host has and that is not one of the owner's integrations: both are `tools.<slug>`. */
  private async freeSlug(wanted: string, scope: RecordScope, ownerKey: string): Promise<string> {
    const taken = async (slug: string) => await slugIsTaken(slug) || this.deps.integrations.getBySlug(slug, scope, ownerKey) !== null
    if (!(await taken(wanted))) return wanted
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const slug = `${wanted.slice(0, 44)}-${suffix}`
      if (!(await taken(slug))) return slug
    }
    throw new Error(`This host has too many apps named ${wanted}.`)
  }

  /** Starts a version and makes it the active one. Answers why it did not start, or null. */
  private async makeActive(app: AppRecord, version: AppVersionRecord): Promise<string | null> {
    try {
      if (version.hasBackend) await this.deps.runners.start(await this.run(app, version))
      else this.deps.runners.stop(app.id, 'The app changed. Call it again.')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await failVersion(app.id, version.number, reason)
      return reason
    }
    await activateVersion({ ...app, name: version.descriptor.name, description: version.descriptor.description, updatedAt: Date.now() }, version.number)
    const active = await this.reload(app.id)
    for (const part of this.lifecycle) await part.activated(active, version.descriptor).catch((error) => log.warn('app_lifecycle_failed', { appId: app.id, error: error instanceof Error ? error.message : String(error) }))
    return null
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

  /** What the app's runner runs for a version. Its signature changes with the version and with the secrets. */
  private async run(app: AppRecord, version: AppVersionRecord): Promise<AppRun> {
    const build = await this.build(app, version)
    if (build.backend === null) throw new Error('This app has no backend.')
    const secrets = readAppSecrets(app.id)
    const declared = Object.fromEntries(version.descriptor.secrets.flatMap((secret) => (secrets[secret.name] ? [[secret.name, secrets[secret.name]]] : [])))
    return {
      appId: app.id,
      signature: `${version.number}:${createHash('sha256').update(JSON.stringify(declared)).digest('hex').slice(0, 16)}`,
      code: build.backend,
      permissions: version.descriptor.permissions,
      ...(await this.deps.storage.folders(app.id)),
      secrets: declared,
      migrations: build.migrations,
      operations: operationKinds(version.descriptor),
    }
  }

  /** Runs one operation for one caller and writes the call log (§5). */
  private async runOperation(app: AppRecord, operation: string, input: StoredValue, caller: AppCaller, authority: AppAuthority | null): Promise<StoredValue> {
    if (app.stopped) throw new Error('This app is stopped. Start it in its menu.')
    const version = await this.requireActiveVersion(app)
    const declared = version.descriptor.operations.find((entry) => entry.name === operation)
    if (!declared) throw new Error(`This app has no operation named ${operation}.`)
    const callId = randomUUID()
    const startedAt = Date.now()
    await insertCall({ id: callId, appId: app.id, version: version.number, operation, caller, startedAt, finishedAt: null, outcome: 'running', error: null })
    try {
      const result = await this.deps.runners.call(await this.run(app, version), {
        name: operation,
        input,
        caller,
        tools: (slug, tool, toolInput) => this.callIntegration(app, version, slug, tool, inputSchema.parse(toolInput), authority),
      })
      await finishCall(callId, 'ok', null, Date.now())
      if (result.changed) emitAppDataChanged(app.id)
      return result.value
    } catch (error) {
      await finishCall(callId, 'failed', error instanceof Error ? error.message : String(error), Date.now())
      // A mutation that failed may have written before it failed.
      if (error instanceof AppOperationError && error.changed) emitAppDataChanged(app.id)
      throw error
    } finally {
      await this.pruneSometimes(app.id)
    }
  }

  private async pruneSometimes(appId: string): Promise<void> {
    const count = (this.callCounts.get(appId) ?? 0) + 1
    this.callCounts.set(appId, count % PRUNE_EVERY_CALLS)
    if (count % PRUNE_EVERY_CALLS === 0) await pruneCalls(appId).catch(() => {})
  }

  /** The caller's own integration with a slug; for the host's own work, the app owner's. */
  private integrationFor(app: AppRecord, slug: string, authority: AppAuthority | null): Integration | null {
    const personKey = authority ? ownerKeyOf(authority.actor) ?? app.ownerKey : app.ownerKey
    return this.deps.integrations.getBySlug(slug, authority ? recordScopeOf(authority.principal) : app.organizationId, personKey)
  }

  /** One integration tool for the app (§5): a role the descriptor names, the caller's own connection, and a tool that is on. */
  private async callIntegration(app: AppRecord, version: AppVersionRecord, slug: string, toolName: string, input: CallInput, authority: AppAuthority | null): Promise<StoredValue> {
    if (!version.descriptor.integrations.includes(slug)) throw new Error(`This app does not name the integration ${slug}. Add it to \`integrations\` in app.ts.`)
    const integration = this.integrationFor(app, slug, authority)
    if (!integration) throw new Error(`Connect ${slug} in Settings → MCP to use this app.`)
    if (integration.disabledTools.includes(toolName)) throw new Error(`The ${toolName} tool of ${integration.name} is turned off in Settings → MCP.`)
    const call = () => this.deps.gateway.callAppTool(integration.id, toolName, input)
    // A schedule or a webhook has no person in its call: the app's owner is the person.
    const result = toolResultSchema.parse(await (authority ? call() : (this.deps.runAs ?? withUserScope)(app.ownerKey, call)))
    const text = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
    if (result.isError) throw new Error(text || `${integration.name} refused the call.`)
    if (result.structuredContent !== undefined) return result.structuredContent
    if (!text) return null
    try {
      return z.json().parse(JSON.parse(text))
    } catch {
      return text
    }
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

  private async state(app: AppRecord, authority: AppAuthority): Promise<AppState> {
    const version = await this.activeVersion(app)
    const secrets = readAppSecrets(app.id)
    const calls = await lastCallTimes([app.id])
    return {
      app: await this.summary(app, calls.get(app.id) ?? null),
      descriptor: version?.descriptor ?? null,
      roles: version ? await this.roles(app, version.descriptor, authority) : [],
      secrets: (version?.descriptor.secrets ?? []).map((secret) => ({ ...secret, isSet: Boolean(secrets[secret.name]) })),
      network: version?.descriptor.permissions.network ?? [],
      permissionsNotice: version ? describeAppPermissions(version.descriptor.permissions, version.hasBackend) : null,
    }
  }

  /** Each role as the reader has it: whether they own an integration with that slug, and whether it is connected. */
  private async roles(app: AppRecord, descriptor: AppDescriptor, authority: AppAuthority): Promise<AppRoleState[]> {
    return Promise.all(descriptor.integrations.map(async (slug) => {
      const integration = this.integrationFor(app, slug, authority)
      if (!integration) return { slug, name: null, connected: false }
      const status = await this.deps.gateway.connectionStatus(integration.id)
      return { slug, name: integration.name, connected: status.status === 'connected' }
    }))
  }

  private async summary(app: AppRecord, lastCallAt: number | null): Promise<AppSummary> {
    const versions = await listVersions(app.id)
    const active = versions.find((version) => version.number === app.activeVersion) ?? null
    const latest = versions[0] ?? null
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      description: app.description,
      organizationId: app.organizationId,
      activeVersion: app.activeVersion,
      latestVersion: latest?.number ?? null,
      stopped: app.stopped,
      hasUi: active?.hasUi ?? false,
      operationCount: active?.descriptor.operations.length ?? 0,
      project: app.project,
      createdBy: app.createdBy,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      lastCallAt,
      attention: await attentionOf(app, active, latest),
    }
  }
}

/** What needs the owner (§9): the app is stopped, its newest version failed, a secret is not set, or a schedule's last run failed. */
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
  for (const schedule of await listSchedules(app.id)) {
    if (schedule.lastOutcome === 'failed') attention.push({ kind: 'schedule-failed', detail: `The schedule ${schedule.name} failed: ${schedule.lastError ?? 'no reason was recorded'}` })
  }
  return attention
}

function operationKinds(descriptor: AppDescriptor): AppRun['operations'] {
  return descriptor.operations.map(({ name, kind }) => ({ name, kind }))
}

/** Only the host's owner uses an app in this release (§2 decision 10); the host's own work acts for them. */
export function mayUseApps(principal: Principal): boolean {
  return principal.kind === 'system' || isHostOwner(principal)
}

function assertMayUse(principal: Principal): void {
  if (!mayUseApps(principal)) throw new Error('Only the owner of this host can use its apps.')
}
