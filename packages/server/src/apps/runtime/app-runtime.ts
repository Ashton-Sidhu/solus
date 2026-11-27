import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { APP_PROTOCOL, appCallerRoleSchema, appCallerUserSchema, appDescriptorSchema, parseAppCallName, type AppCallTarget, type AppCallerRole, type AppCallerUser, type AppDescriptor } from '@solus/contracts/apps'
import {
  APP_RUNTIME_PROTOCOLS,
  APP_SIGN_IN_ENTER_PATH,
  APP_SIGN_IN_ENTRY_PATH,
  appAccessModeSchema,
  appSecretEnvName,
  appSignInEntrySchema,
  appSignInSchema,
  appVisitorRoleSchema,
  appWebhookSecretEnvName,
  type AppAccess,
  type AppDeploymentStatus,
  type AppManagementOperation,
  type AppRuntimeHealth,
  type AppVersionPush,
  type AppVersionPushReceipt,
} from '@solus/contracts/app-deployments'
import { actorFor } from '../../admission/actor'
import { ANY_ORGANIZATION, INTERNAL_PRINCIPAL } from '../../admission/principal'
import {
  callCountsSince,
  failInterruptedBuilds,
  failInterruptedCalls,
  insertApp,
  insertVersion,
  listApps,
  loadApp,
  loadVersion,
  saveApp,
  saveVersionBuild,
  type AppRecord,
} from '../../data/apps/app-store'
import { listRuns } from '../../data/apps/app-workflow-store'
import { hostAttribution } from '../../data/stored-attribution'
import { requestData } from '../../execution/webhooks/request-data'
import { verifyRequest } from '../../execution/webhooks/verification'
import { hostUserKey } from '../../host/host-user'
import { createLogger } from '../../logger'
import { dataDir } from '../../platform/paths'
import { onAppDataChanged } from '../app-events'
import { AppFiles } from '../app-files'
import { buildFiles } from '../app-project'
import { AppRunners, type AppRunnersOptions } from '../app-runners'
import { AppSchedules } from '../app-schedules'
import { useAppSecretSource, type AppSecretValues } from '../app-secrets'
import { AppSignals } from '../app-signals'
import { AppStorage, type StoredValue } from '../app-storage'
import { webhookInput } from '../app-webhooks'
import { AppWorkflows } from '../app-workflows'
import { Apps, type AppAuthority, type AppLifecyclePart, type AppsDeps } from '../apps'
import { DeploymentBuilds } from './deployment-builds'
import { SolusServiceClient } from './solus-service-client'

const log = createLogger('apps', 'app-runtime.ts')

/**
 * The runtime of one deployment (docs/plans/app-deploy.md §5.1): the program
 * in a `solus-apps-runtime` container. It is the Apps service of a host with
 * one app in it, over its own data folder, and with no source: Solus builds
 * each version and sends it here (§5.3). It answers the app's UI in a
 * visitor's browser (§7), and it runs the app's schedules and workflows. What
 * a host owns and a deployment does not (a connection, a session, an
 * automation) it asks of Solus over the service API (§5.2), or refuses.
 */

const NO_SOLUS = 'This deployment has no Solus to ask for that.'
const NO_BUILD = 'A deployment does not build. Publish the version from Solus.'
const DAY_MS = 24 * 60 * 60_000
/** How long a visitor who came in with the link stays in. A new link ends each session at once. */
const SESSION_MS = 30 * DAY_MS
/** How long a person who signed in stays in. Their role is read again at the next sign-in, so a change of the list holds in half a day. */
const PERSON_SESSION_MS = 12 * 60 * 60_000
const SIGN_IN_TIMEOUT_MS = 20_000

/** A request that is valid, and that this deployment does not take. */
export class AppRuntimeRefusal extends Error {}

/** The access as the deployment keeps it: the hash of the link's secret, never the secret. */
const storedAccessSchema = z.object({ mode: appAccessModeSchema, role: appVisitorRoleSchema, secretHash: z.string().regex(/^[a-f0-9]{64}$/), signIn: appSignInSchema.optional() })
type StoredAccess = z.infer<typeof storedAccessSchema>

/** Who a request at the address is: what they may do, and the person when they signed in. */
export interface AppVisitor {
  role: AppCallerRole
  user?: AppCallerUser
}

/** The person of a session, as its cookie carries it. */
const personSchema = z.object({ user: appCallerUserSchema, role: appCallerRoleSchema })

/** What a webhook's request gets back. */
export interface AppWebhookAnswer {
  status: 200 | 401 | 404 | 409
  error: string | null
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** What a viewer may call: what reads. Each other call changes something. */
function isRead(target: AppCallTarget, descriptor: AppDescriptor | null): boolean {
  if (target.kind === 'config') return true
  if (target.kind === 'storage') return target.operation === 'get' || target.operation === 'keys'
  if (target.kind === 'files') return target.operation === 'list' || target.operation === 'read'
  return target.kind === 'operation' && descriptor?.operations.find((operation) => operation.name === target.name)?.kind === 'query'
}

export interface AppRuntimeOptions {
  /** The Solus release this runtime was made from. */
  release: string
  /** The env vars of the process: the app's own secrets are `SOLUS_APP_SECRET_<NAME>`. */
  env?: NodeJS.ProcessEnv
  runners?: AppRunnersOptions
  now?: () => number
  /** The Solus of this deployment: its URL and the app key (§5.2). Null or absent, the app runs with no Solus. */
  solus?: { url: string; appKey: string } | null
  /** How the deployment asks Solus Cloud for the person of a sign-in (§7.3). */
  fetchImpl?: typeof fetch
}

export class AppRuntime {
  readonly apps: Apps
  private readonly runners: AppRunners
  private readonly files: AppFiles
  private readonly schedules: AppSchedules
  private readonly workflows: AppWorkflows
  private readonly builds = new DeploymentBuilds()
  /** The names of the secrets that each app's active version declares. */
  private readonly declaredSecrets = new Map<string, string[]>()
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private access: StoredAccess | null = null
  /** The deployment itself, which acts as the app's owner: a visitor has no identity in Solus. */
  private readonly owner: AppAuthority = { principal: INTERNAL_PRINCIPAL, actor: actorFor(INTERNAL_PRINCIPAL) }

  constructor(private readonly options: AppRuntimeOptions) {
    this.env = options.env ?? process.env
    this.now = options.now ?? Date.now
    this.runners = new AppRunners(options.runners)
    const storage = new AppStorage()
    this.files = new AppFiles(storage)
    const solus = options.solus ? new SolusServiceClient(options.solus.url, options.solus.appKey) : null
    const deps: AppsDeps = {
      gateway: {
        callAppTool: async () => { throw new Error(NO_SOLUS) },
        toolsFor: async () => { throw new Error(NO_SOLUS) },
        connectionStatus: async () => { throw new Error(NO_SOLUS) },
      },
      integrations: { getBySlug: () => null },
      connections: { connected: async () => false, request: async () => { throw new Error(NO_SOLUS) } },
      storage,
      runners: this.runners,
      repositories: this.builds,
      builder: {
        buildRevision: async () => { throw new Error(NO_BUILD) },
        buildProject: async () => { throw new Error(NO_BUILD) },
        remove: async () => {},
      },
      files: this.files,
    }
    // With a Solus, each tool of an app connection is a call to it (§5.2).
    if (solus) deps.remoteTools = solus
    this.apps = new Apps(deps)
    this.schedules = new AppSchedules(this.apps, this.now)
    this.workflows = new AppWorkflows(this.apps, this.runners, this.now)
    const signals = new AppSignals(this.apps, {
      sendToSession: async () => { throw new Error(NO_SOLUS) },
      runAutomation: async () => { throw new Error(NO_SOLUS) },
    }, this.now)
    const secrets: AppLifecyclePart = {
      activated: async (app, descriptor) => { this.declaredSecrets.set(app.id, descriptor.secrets.map((secret) => secret.name)) },
      removed: async (app) => { this.declaredSecrets.delete(app.id) },
    }
    // The secrets part is first: a start reads the secrets of the version it starts.
    // With a Solus, the signals of the app go there: its owner's signal actions are in Solus.
    for (const part of [secrets, this.schedules, ...(solus ? [] : [signals]), this.workflows]) this.apps.addLifecyclePart(part)
    this.apps.useWorkflows(this.workflows)
    this.apps.useSignals(solus ?? signals)
    // A model call runs in Solus, with the owner's model account. With no Solus, the app's code gets the refusal of `Apps`.
    if (solus) this.apps.useModelCalls(solus)
  }

  /** The process started: what a stop interrupted is marked, and the timers of the app start again. */
  async start(): Promise<void> {
    useAppSecretSource((appId) => this.secretsOf(appId))
    await failInterruptedBuilds()
    await failInterruptedCalls(this.now())
    for (const app of await listApps(ANY_ORGANIZATION)) {
      const version = app.activeVersion === null ? null : await loadVersion(app.id, app.activeVersion)
      if (version) this.declaredSecrets.set(app.id, version.descriptor.secrets.map((secret) => secret.name))
    }
    const stored = await readFile(this.accessFile(), 'utf8').then((text) => storedAccessSchema.safeParse(JSON.parse(text)), () => null)
    this.access = stored?.success ? stored.data : null
    this.schedules.start()
    this.workflows.start()
    log.info('app_runtime_started', { release: this.options.release })
  }

  stop(): void {
    this.schedules.stop()
    this.workflows.stop()
    this.files.dispose()
    this.runners.dispose()
    useAppSecretSource(null)
  }

  private accessFile(): string {
    return join(dataDir(), 'apps', 'access.json')
  }

  /** The app's own secrets, from the env vars of the process (decision 14). */
  private secretsOf(appId: string): AppSecretValues {
    const secrets: AppSecretValues = {}
    for (const name of this.declaredSecrets.get(appId) ?? []) {
      const value = this.env[appSecretEnvName(name)]
      if (value) secrets[name] = value
    }
    return secrets
  }

  /** The one app of this deployment; null before the first version arrived. */
  private async app(): Promise<AppRecord | null> {
    return (await listApps(ANY_ORGANIZATION))[0] ?? null
  }

  /**
   * What a platform reads with no key: that the process answers, and when
   * the app must run next. A platform that stops an idle container (§8.3)
   * starts it again at that time, and keeps it while a run is in progress.
   */
  async health(): Promise<AppRuntimeHealth> {
    const app = await this.app()
    if (!app || app.stopped) return { ok: true, nextWakeAt: null }
    const schedules = (await this.schedules.list(this.owner, app.id)).flatMap((schedule) => (schedule.nextRunAt === null ? [] : [schedule.nextRunAt]))
    // A run in progress is due now: the container must stay until it ends or sleeps.
    const running = (await listRuns(app.id, 1, { state: 'running' })).map(() => this.now())
    const sleeping = (await listRuns(app.id, 100, { state: 'sleeping' })).map((run) => run.wakeAt ?? this.now())
    const due = [...schedules, ...running, ...sleeping]
    return { ok: true, nextWakeAt: due.length > 0 ? Math.min(...due) : null }
  }

  /** One operation of the app for a model call that Solus runs for this deployment (§5.2). */
  async callOperation(request: AppManagementOperation): Promise<StoredValue> {
    const app = await this.app()
    if (!app) throw new AppRuntimeRefusal('This deployment has no version yet.')
    return this.apps.callOperation(app.id, request.operation, request.input, request.caller, null)
  }

  async status(): Promise<AppDeploymentStatus> {
    const app = await this.app()
    const counts = app ? (await callCountsSince([app.id], this.now() - DAY_MS)).get(app.id) : undefined
    return {
      runtime: { release: this.options.release, protocols: [...APP_RUNTIME_PROTOCOLS] },
      activeVersion: app?.activeVersion ?? null,
      calls24h: counts?.calls ?? 0,
      failed24h: counts?.failed ?? 0,
      access: this.access?.mode ?? null,
    }
  }

  /**
   * Takes one version that Solus built and makes it active (§5.3). The first
   * version makes the app's record, with the id it has in Solus. A version
   * that does not start is recorded as failed, and the version before it
   * still runs. A push of a version that is here already makes it active
   * again, so Solus can send the same request twice.
   */
  async receiveVersion(push: AppVersionPush): Promise<AppVersionPushReceipt> {
    const at = this.now()
    const descriptor = appDescriptorSchema.parse(push.build.descriptor)
    const current = await this.app()
    if (current && current.id !== push.app.id) throw new AppRuntimeRefusal(`This deployment holds the app ${current.slug}. It does not take another app.`)
    let app = current
    if (!app) {
      app = {
        id: push.app.id, organizationId: 'local', ownerKey: hostUserKey(), slug: push.app.slug,
        name: descriptor.name.slice(0, 80), description: descriptor.description, customName: null, customDescription: null, colorHue: null,
        activeVersion: null, stopped: false, agentAccess: true,
        repository: this.builds.nameFor('local', push.app.id), latestRevision: push.sourceCommit, project: null, createdBy: hostAttribution(),
        webhookIds: {}, createdAt: at, updatedAt: at,
      }
      await insertApp(app)
    } else if (app.latestRevision !== push.sourceCommit) {
      await saveApp({ ...app, latestRevision: push.sourceCommit, updatedAt: at })
    }
    // The access is of the deployment, not of the version: it holds when the version does not start.
    if (push.access) await this.setAccess(push.access)

    const existing = await loadVersion(app.id, push.number)
    if (!existing?.buildCommit) {
      if (!existing) {
        await insertVersion({
          appId: app.id, number: push.number, sourceCommit: push.sourceCommit, buildCommit: '',
          descriptor: appDescriptorSchema.parse({ solusApp: APP_PROTOCOL, name: descriptor.name }), hasBackend: false, hasUi: false, iconHash: null,
          state: 'building', error: null, buildLog: null, buildMs: null, message: push.message, createdBy: hostAttribution(), createdAt: at, activations: [],
        })
      }
      const buildCommit = await this.builds.commitBuild(app.repository, {
        number: push.number, revision: push.sourceCommit, at,
        files: buildFiles({ descriptor, backend: push.build.backend, ui: push.build.ui, menuBar: null, icon: null, migrations: push.build.migrations }),
      })
      await saveVersionBuild({ appId: app.id, number: push.number, buildCommit, descriptor, hasBackend: push.build.backend !== null, hasUi: push.build.ui !== null, iconHash: null, buildLog: null, buildMs: null })
    }
    // A start reads the secrets this version declares, which the last active version may not have.
    this.declaredSecrets.set(app.id, descriptor.secrets.map((secret) => secret.name))
    try {
      await this.apps.activate(this.owner, app.id, push.number)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const active = (await loadApp(ANY_ORGANIZATION, app.id))?.activeVersion ?? null
      const stillRuns = active === null ? null : await loadVersion(app.id, active)
      this.declaredSecrets.set(app.id, stillRuns?.descriptor.secrets.map((secret) => secret.name) ?? [])
      log.warn('app_runtime_version_failed', { appId: app.id, version: push.number, error: reason })
      return { version: push.number, active: false, error: reason }
    }
    // The app runs here with the config it has in Solus. A field the version does not declare is not a value of it.
    for (const field of descriptor.config) {
      const value = push.config[field.name]
      if (value !== undefined) await this.apps.configSet(this.owner, app.id, field.name, value).catch((error) => log.warn('app_runtime_config_refused', { appId: app.id, name: field.name, error: error instanceof Error ? error.message : String(error) }))
    }
    log.info('app_runtime_version_active', { appId: app.id, version: push.number })
    return { version: push.number, active: true, error: null }
  }

  private async setAccess(access: AppAccess): Promise<void> {
    this.access = { mode: access.mode, role: access.role, secretHash: sha256(access.linkSecret), signIn: access.signIn }
    await mkdir(dirname(this.accessFile()), { recursive: true, mode: 0o700 })
    await writeFile(this.accessFile(), JSON.stringify(this.access), { mode: 0o600 })
  }

  // ─── A visitor (§7) ───

  private mac(text: string, access: StoredAccess): string {
    return createHmac('sha256', access.secretHash).update(text).digest('hex')
  }

  private sameMac(expected: string, given: string): boolean {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'))
  }

  /** How a visitor comes in: with the link, with a sign-in, or with nothing when the app is public. Null before the first publish. */
  accessMode(): StoredAccess['mode'] | null {
    return this.access?.mode ?? null
  }

  /** The session of a visitor who has the link: it holds while the link does. Null for a secret that is not the link's. */
  enter(secret: string): { session: string; maxAgeSeconds: number } | null {
    const access = this.access
    if (!access || access.mode !== 'link' || !this.sameMac(sha256(secret), access.secretHash)) return null
    const expiresAt = this.now() + SESSION_MS
    return { session: `${expiresAt}.${this.mac(`session\n${expiresAt}`, access)}`, maxAgeSeconds: Math.floor(SESSION_MS / 1000) }
  }

  /**
   * Who the bearer of this session is; null for nobody. A public app answers
   * each person. An app with a link answers a session that the link made. An
   * app for named people answers a session that a sign-in made, and that
   * session names the person. A deployment with no access yet answers nobody.
   */
  visitorOf(session: string | null): AppVisitor | null {
    const access = this.access
    if (!access) return null
    if (access.mode === 'public') return { role: access.role }
    if (access.mode === 'link') {
      const match = /^(\d{1,16})\.([a-f0-9]{64})$/.exec(session ?? '')
      if (!match || Number(match[1]) < this.now()) return null
      return this.sameMac(this.mac(`session\n${match[1]}`, access), match[2] ?? '') ? { role: access.role } : null
    }
    const match = /^p\.(\d{1,16})\.([A-Za-z0-9_-]{1,2000})\.([a-f0-9]{64})$/.exec(session ?? '')
    if (!match || Number(match[1]) < this.now()) return null
    if (!this.sameMac(this.mac(`person\n${match[1]}\n${match[2]}`, access), match[3] ?? '')) return null
    try {
      return personSchema.parse(JSON.parse(Buffer.from(match[2] ?? '', 'base64url').toString('utf8')))
    } catch {
      return null
    }
  }

  /**
   * The start of a sign-in (§7.3): where the browser goes, and what this
   * deployment keeps in a cookie of that browser until it comes back. The
   * verifier never leaves the cookie; Solus Cloud gets only its hash, so a
   * code that another program saw is of no use to it.
   */
  signInStart(): { location: string; pending: string } | null {
    const signIn = this.access?.mode === 'people' ? this.access.signIn : undefined
    if (!signIn) return null
    const state = randomBytes(16).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const location = new URL(APP_SIGN_IN_ENTER_PATH, signIn.origin)
    location.searchParams.set('app', signIn.app)
    location.searchParams.set('state', state)
    location.searchParams.set('challenge', createHash('sha256').update(verifier).digest('base64url'))
    return { location: location.toString(), pending: `${state}.${verifier}` }
  }

  /**
   * The end of a sign-in: Solus Cloud says who the person is and what the
   * owner lets them do, and they get a session. The answer is a refusal when
   * the app is not shared with the person; the deployment then never learns
   * who they are.
   */
  async signInFinish(code: string, state: string, pending: string | null): Promise<{ session: string; maxAgeSeconds: number } | { refusal: string }> {
    const access = this.access
    const signIn = access?.mode === 'people' ? access.signIn : undefined
    const [expectedState, verifier] = (pending ?? '').split('.')
    if (!access || !signIn) return { refusal: 'This app does not use a sign-in.' }
    if (!expectedState || !verifier || expectedState !== state) return { refusal: 'This sign-in did not start in this browser. Open the app again.' }
    const response = await (this.options.fetchImpl ?? fetch)(new URL(APP_SIGN_IN_ENTRY_PATH, signIn.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: signIn.app, code, verifier }),
      signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
    }).catch(() => null)
    if (!response) return { refusal: 'Solus did not answer. Try again.' }
    const entry = response.ok ? appSignInEntrySchema.safeParse(await response.json().catch(() => null)) : null
    if (!entry?.success) return { refusal: response.status === 403 ? 'This app is not shared with you. Ask its owner.' : 'The sign-in did not finish. Open the app again.' }
    const expiresAt = this.now() + PERSON_SESSION_MS
    const person = Buffer.from(JSON.stringify(entry.data), 'utf8').toString('base64url')
    log.info('app_runtime_signed_in', { role: entry.data.role })
    return { session: `p.${expiresAt}.${person}.${this.mac(`person\n${expiresAt}\n${person}`, access)}`, maxAgeSeconds: Math.floor(PERSON_SESSION_MS / 1000) }
  }

  // ─── A webhook (§7.4) ───

  /**
   * One request of another service for a webhook that the active version
   * declares. The check of the request is the one the webhook has in Solus,
   * with the same signing secret, which is an env var here. A deployment
   * keeps no delivery log and no replay: the request runs the mutation once,
   * or it is refused.
   */
  async webhook(name: string, method: string, headers: Iterable<[string, string]>, query: Iterable<[string, string]>, body: Buffer): Promise<AppWebhookAnswer> {
    const app = await this.app()
    const version = app?.activeVersion == null ? null : await loadVersion(app.id, app.activeVersion)
    const declared = version?.descriptor.webhooks.find((webhook) => webhook.name === name)
    if (!app || !declared) return { status: 404, error: 'This app has no such webhook.' }
    const data = requestData(method, headers, query, body)
    const secret = this.env[appWebhookSecretEnvName(name)]
    const verified = await verifyRequest(declared.verify, data, { secret: secret ? Buffer.from(secret, 'base64') : null, now: this.now() })
    if (!verified.ok) {
      log.info('app_runtime_webhook_refused', { appId: app.id, webhook: name, step: verified.failure.step })
      return { status: 401, error: `The request was refused: ${verified.failure.step}.` }
    }
    try {
      await this.apps.callOperation(app.id, declared.run, webhookInput(data), { kind: 'webhook', webhookId: name }, null)
      return { status: 200, error: null }
    } catch (error) {
      // The sender tries again on a failure. The reason is in the call log of the deployment, not in the answer.
      log.warn('app_runtime_webhook_failed', { appId: app.id, webhook: name, error: error instanceof Error ? error.message : String(error) })
      return { status: 409, error: 'The app did not take the request.' }
    }
  }

  /** The built UI of the active version, and the network hosts its page may reach; null when the app has none. */
  async ui(): Promise<{ html: string; name: string; network: string[] } | null> {
    const app = await this.app()
    if (!app) return null
    const ui = await this.apps.ui(this.owner, app.id)
    const version = app.activeVersion === null ? null : await loadVersion(app.id, app.activeVersion)
    return ui && version ? { html: ui.html, name: app.customName ?? app.name, network: version.descriptor.permissions.network } : null
  }

  /** One call of the app's UI for a visitor: `{ value }` as JSON text. A viewer runs only what reads. */
  async uiCall(name: string, argumentsJson: string, visitor: AppVisitor): Promise<string> {
    const app = await this.app()
    if (!app) throw new Error('This app has no version yet.')
    const target = parseAppCallName(name)
    if (!target) throw new Error(`This app cannot call ${name}.`)
    const version = app.activeVersion === null ? null : await loadVersion(app.id, app.activeVersion)
    if (visitor.role === 'viewer' && !isRead(target, version?.descriptor ?? null)) throw new Error('You can read in this app, and you cannot change it.')
    // `ctx.caller` has the role, and the person only when they signed in: a visitor with the link is nobody to Solus.
    return this.apps.call(this.owner, app.id, name, argumentsJson, visitor)
  }

  /** Calls `listener` each time the app's data changed. Returns the way to stop. */
  onDataChanged(listener: () => void): () => void {
    return onAppDataChanged(() => listener())
  }
}
