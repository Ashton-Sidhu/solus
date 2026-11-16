import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  APP_DEPLOYMENT_ENV,
  APP_WEBHOOK_PATH_PREFIX,
  appAccessModeSchema,
  appAccessSubjectSchema,
  appKeySchema,
  appLinkSecretSchema,
  appPlatformKindSchema,
  appPublishRequestSchema,
  appSecretEnvName,
  appSignInSchema,
  appVisitorRoleSchema,
  appWebhookSecretEnvName,
  type AppAccess,
  type AppAccessSubject,
  type AppDeploymentView,
  type AppManagementOperation,
  type AppPlatformKind,
  type AppPublishPlace,
  type AppPublishPlaces,
  type AppPublishReceipt,
  type AppPublishRequest,
  type AppSignIn,
  type AppVersionPush,
} from '@solus/contracts/app-deployments'
import { SECRET_SCHEMES } from '@solus/contracts/webhooks'
import { isHostOwner } from '../../admission/principal'
import type { AppRecord } from '../../data/apps/app-store'
import { readWebhookSecrets } from '../../data/webhooks/webhook-secrets'
import { createLogger } from '../../logger'
import { dataDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'
import { emitAppActivity } from '../app-events'
import type { AppSecretValues } from '../app-secrets'
import type { StoredValue } from '../app-storage'
import type { AppAuthority, AppLifecyclePart, Apps } from '../apps'
import { newAppKey } from '../runtime/management-signature'
import type { AppDeploymentSpec, AppPlatform } from './app-platform'
import { DeploymentClient } from './deployment-client'

const log = createLogger('apps', 'app-deployments.ts')

/**
 * The deployments of this Solus (docs/plans/app-deploy.md §5): the published
 * copy of an app that runs in a container. The app itself stays here. A
 * publish sends the built active version to the deployment and makes the
 * deployment first when the app has none; nothing else of the app's life here
 * changes. The record of each deployment is a file beside the app data, as an
 * app's config is: a new table would change the database baseline. The app
 * key and the secret of the link are in the secret store, never in that file.
 */

const recordSchema = z.object({
  appId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  platform: appPlatformKindSchema,
  /** The connected host that runs the container (§8.5), with the name it had at the publish; null when this host runs it. */
  hostId: z.string().nullable().default(null),
  hostLabel: z.string().nullable().default(null),
  tailscaleAddress: z.boolean(),
  access: appAccessModeSchema,
  role: appVisitorRoleSchema,
  /** Who opens the app with the access `people`. Kept under another access, so a change back has the list. */
  subjects: z.array(appAccessSubjectSchema).default([]),
  /** What Solus Cloud gave for the sign-in of the copy, while the access is `people`. */
  signIn: appSignInSchema.nullable().default(null),
  /** The webhooks that the published version declares, by name. */
  webhooks: z.array(z.string()).default([]),
  /** Where this Solus reaches the management API. */
  origin: z.string().min(1),
  address: z.string().min(1),
  /** The version that was published last. */
  version: z.number().int().positive(),
  /** What the container's env vars were made from: a publish with other secrets starts the container again. */
  secretsDigest: z.string(),
  createdAt: z.number(),
  publishedAt: z.number(),
})
type DeploymentRecord = z.infer<typeof recordSchema>
/** Where a deployment runs: the kind of place, and the connected host when this host does not run it. */
type DeploymentPlace = Pick<DeploymentRecord, 'platform' | 'hostId'>

/** A connected host that runs containers for this Solus. */
export interface ConnectedContainerHost {
  /** The id of the host, whatever name the request found it by. */
  id: string
  label: string
  platform: AppPlatform
}

const storedSecretsSchema = z.object({ key: appKeySchema, linkSecret: appLinkSecretSchema })
type StoredSecrets = z.infer<typeof storedSecretsSchema>

export interface AppDeploymentsOptions {
  platforms: readonly AppPlatform[]
  /** The runtime image, with its tag: an exported image starts from it. */
  runtimeImage: () => string
  /** The URL at which a deployment in this place reaches the service API of this Solus (§5.2); empty when it reaches none. */
  solusUrl: (platform: AppPlatformKind, hostId: string | null) => string | Promise<string>
  /** The connected hosts of the owner that can run a container (§8.5). Absent on a Solus that reaches no other host. */
  connectedHosts?: {
    list(): Promise<{ id: string; label: string }[]>
    /** Rejects with why this Solus does not reach the host. */
    connect(hostId: string): Promise<ConnectedContainerHost>
  }
  /** This host has a Tailscale auth key (§8.2). */
  hasTailscaleKey?: () => boolean
  /** The sign-in of a copy whose owner named people (§7.3): Solus Cloud keeps the list and signs each visitor in. Absent on a Solus with no account plane. */
  signIn?: {
    isSignedIn(): boolean
    setAccess(appId: string, access: { slug: string; address: string; subjects: readonly AppAccessSubject[] }): Promise<AppSignIn>
    removeAccess(appId: string): Promise<void>
  }
  root?: () => string
  now?: () => number
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

/** The digest of what the env vars of a container are made from. */
function envDigest(secrets: AppSecretValues, webhookSecrets: AppSecretValues): string {
  const sorted = (values: AppSecretValues) => Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
  // A deployment with no webhook secret has the digest it had before webhooks came to a deployment.
  return digest(JSON.stringify(Object.keys(webhookSecrets).length === 0 ? sorted(secrets) : [sorted(secrets), sorted(webhookSecrets)])).toString('hex')
}

/**
 * The signing secret of each webhook that a version declares, base64: the
 * one the webhook has in Solus, so the other service signs with one secret
 * for the app and for its copy.
 */
function webhookSecretsOf(app: AppRecord, push: AppVersionPush): AppSecretValues {
  const secrets: AppSecretValues = {}
  for (const declared of push.build.descriptor.webhooks) {
    const webhookId = app.webhookIds[declared.name]
    const secret = webhookId && SECRET_SCHEMES.includes(declared.verify.scheme) ? readWebhookSecrets(webhookId)?.secret : undefined
    if (secret) secrets[declared.name] = secret
  }
  return secrets
}

/** What one publish asks for, with each thing the request did not name. */
type PublishChoices = DeploymentPlace & Pick<DeploymentRecord, 'hostLabel' | 'tailscaleAddress' | 'access' | 'role' | 'subjects'>

/** A thing the request does not name stays as the deployment has it: a publish of a new version must not make a public app private. */
function publishChoices(request: z.infer<typeof appPublishRequestSchema>, existing: DeploymentRecord | null): PublishChoices {
  return {
    platform: request.platform ?? existing?.platform ?? 'docker',
    hostId: request.hostId === undefined ? existing?.hostId ?? null : request.hostId,
    hostLabel: null,
    tailscaleAddress: request.tailscaleAddress ?? existing?.tailscaleAddress ?? false,
    access: request.access ?? existing?.access ?? 'link',
    role: request.role ?? existing?.role ?? 'editor',
    subjects: request.subjects ?? existing?.subjects ?? [],
  }
}

/** The data of a deployment is in the place that runs it: a publish to another place is refused. */
function assertSamePlace(existing: DeploymentRecord, place: DeploymentPlace): void {
  if (existing.platform !== place.platform) throw new Error(`This app is published to ${existing.platform}. Unpublish it before you publish it to ${place.platform}.`)
  if (existing.hostId !== place.hostId) throw new Error(`This app is published on ${existing.hostLabel ?? 'this host'}. Unpublish it before you publish it on another host.`)
}

function assertMayPublish(authority: AppAuthority): void {
  if (authority.principal.kind !== 'system' && !isHostOwner(authority.principal)) throw new Error('Only the owner of this host can publish its apps.')
}

export class AppDeployments implements AppLifecyclePart {
  /** The digest of each app key, by app id: the service API finds the app of a key without a read of the secret store. */
  private keyDigests: Map<string, Buffer> | null = null
  private readonly root: () => string
  private readonly now: () => number

  constructor(private readonly apps: Pick<Apps, 'published' | 'record'>, private readonly options: AppDeploymentsOptions) {
    this.root = options.root ?? (() => join(dataDir(), 'apps', 'deployments'))
    this.now = options.now ?? Date.now
  }

  private file(appId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(appId)) throw new Error('This app has no deployment: its id is not a file name.')
    return join(this.root(), `${appId}.json`)
  }

  private secretsPath(appId: string): string {
    const dir = join(dataDir(), 'app-secrets')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return join(dir, `deployment-${appId}.bin`)
  }

  private secretsOf(appId: string): StoredSecrets | null {
    return secretStore().loadJson(`app-deployment-${appId}`, this.secretsPath(appId), storedSecretsSchema)
  }

  /** The adapter of one place: a platform of this host, or the Docker of a connected host. */
  private async platformOf(place: DeploymentPlace): Promise<AppPlatform> {
    if (place.hostId !== null) return (await this.connectedHost(place)).platform
    const platform = this.options.platforms.find((entry) => entry.kind === place.platform)
    if (!platform) throw new Error(`This Solus cannot publish to ${place.platform}.`)
    return platform
  }

  private async connectedHost(place: DeploymentPlace): Promise<ConnectedContainerHost> {
    if (place.platform !== 'docker') throw new Error('Only a deployment in Docker runs on a connected host.')
    if (place.hostId === null || !this.options.connectedHosts) throw new Error('This Solus reaches no other host.')
    return this.options.connectedHosts.connect(place.hostId)
  }

  /**
   * The places a first publish offers, and what this host has for a publish.
   * A platform of this host says what it lacks now. A connected host is
   * listed with no check: it says what it lacks when it runs the container.
   */
  async publishPlaces(authority: AppAuthority): Promise<AppPublishPlaces> {
    assertMayPublish(authority)
    const probe: AppDeploymentSpec = { appId: 'probe', slug: 'probe', env: {}, tailscaleAddress: false }
    const own = await Promise.all(this.options.platforms.map(async (platform): Promise<AppPublishPlace> => {
      const readiness = await platform.readiness(probe).catch((error: Error) => ({ ready: false as const, problem: error.message }))
      return { platform: platform.kind, host: null, problem: readiness.ready ? null : readiness.problem }
    }))
    const hosts = await this.options.connectedHosts?.list().catch(() => []) ?? []
    const connected = hosts.map((host): AppPublishPlace => ({ platform: 'docker', host, problem: null }))
    // Docker on the host of the app, then on each connected host, then the other platforms.
    const places = [...own.filter((place) => place.platform === 'docker'), ...connected, ...own.filter((place) => place.platform !== 'docker')]
    return { places, hasTailscaleKey: this.options.hasTailscaleKey?.() ?? false, canNamePeople: this.options.signIn?.isSignedIn() ?? false }
  }

  /** One operation of the app in its deployment, for a model call that this Solus runs for the deployment (§5.2). */
  async callOperation(appId: string, request: AppManagementOperation): Promise<StoredValue> {
    const record = await this.record(appId)
    const stored = record ? this.secretsOf(appId) : null
    if (!record || !stored) throw new Error('This app is not published.')
    return this.clientOf(await this.platformOf(record), record, stored.key).callOperation(request)
  }

  private clientOf(platform: AppPlatform, record: Pick<DeploymentRecord, 'appId' | 'origin'>, key: string): DeploymentClient {
    return new DeploymentClient(record.origin, key, platform.management?.(record.appId))
  }

  private async record(appId: string): Promise<DeploymentRecord | null> {
    const text = await readFile(this.file(appId), 'utf8').catch(() => null)
    const parsed = text === null ? null : recordSchema.safeParse(JSON.parse(text))
    return parsed?.success ? parsed.data : null
  }

  private async save(record: DeploymentRecord): Promise<void> {
    await mkdir(this.root(), { recursive: true, mode: 0o700 })
    await writeFile(this.file(record.appId), JSON.stringify(record), { mode: 0o600 })
  }

  /** What a platform runs for one app: its env vars are the app key, the URL of this Solus, and the app's own secrets (decision 14). */
  private async spec(app: AppRecord, place: DeploymentPlace & Pick<DeploymentRecord, 'tailscaleAddress'>, key: string, secrets: AppSecretValues, webhookSecrets: AppSecretValues): Promise<AppDeploymentSpec> {
    return {
      appId: app.id,
      slug: app.slug,
      tailscaleAddress: place.tailscaleAddress,
      env: {
        [APP_DEPLOYMENT_ENV.appKey]: key,
        [APP_DEPLOYMENT_ENV.solusUrl]: await this.options.solusUrl(place.platform, place.hostId),
        ...Object.fromEntries(Object.entries(secrets).map(([name, value]) => [appSecretEnvName(name), value])),
        ...Object.fromEntries(Object.entries(webhookSecrets).map(([name, value]) => [appWebhookSecretEnvName(name), value])),
      },
    }
  }

  /**
   * Sends the active version of an app to its deployment (§5.3). The first
   * publish makes the deployment. A later one starts the container again
   * only when its env vars changed: the app's secrets, or where it runs. A
   * version that does not start there leaves the version before it running.
   */
  async publish(authority: AppAuthority, input: AppPublishRequest): Promise<AppPublishReceipt> {
    const asked = appPublishRequestSchema.parse(input)
    const { app, push, secrets } = await this.apps.published(authority, asked.appId)
    const existing = await this.record(app.id)
    const stored = existing ? this.secretsOf(app.id) : null
    const request = publishChoices(asked, existing)
    // A request names a host by its id or its name. The record keeps the id, and the name the host has now.
    const host = request.hostId === null ? null : await this.connectedHost(request)
    if (host) Object.assign(request, { hostId: host.id, hostLabel: host.label })
    const place: DeploymentPlace = request
    if (existing) assertSamePlace(existing, place)
    if (request.access === 'people' && !this.options.signIn?.isSignedIn()) throw new Error('Sign in to Solus on the host of the app to name the people who open it.')
    const kept: StoredSecrets = { key: stored?.key ?? newAppKey(), linkSecret: stored && !asked.newLink ? stored.linkSecret : randomBytes(32).toString('base64url') }
    const isNew = !existing || !stored
    const at = this.now()

    const platform = host?.platform ?? await this.platformOf(place)
    const current = await this.container(platform, app, request, isNew ? null : existing, kept.key, { app: secrets, webhooks: webhookSecretsOf(app, push) }, push.number, at)
    // The key is kept before the first version starts: the app may call the service API as it starts.
    secretStore().saveJson(`app-deployment-${app.id}`, this.secretsPath(app.id), kept)
    await this.save(current)
    this.keyDigests = null

    const client = this.clientOf(platform, current, kept.key)
    const receipt = await client.ready()
      .then(async () => client.pushVersion({ ...push, access: await this.accessOf(app, current, request, kept.linkSecret) }))
      .catch(async (error: Error) => {
        if (isNew) await this.discard(current)
        throw error
      })
    if (!receipt.active && isNew) {
      // A deployment whose first version did not start has nothing to run.
      await this.discard(current)
      throw new Error(`The app did not start in its deployment: ${receipt.error ?? 'no reason given'}`)
    }
    const next: DeploymentRecord = { ...current, access: request.access, role: request.role, subjects: request.subjects }
    if (receipt.active) {
      next.webhooks = push.build.descriptor.webhooks.map((webhook) => webhook.name)
      next.version = push.number
      next.publishedAt = at
    }
    await this.save(next)
    emitAppActivity(app.id, 'deployment')
    log.info('app_published', { appId: app.id, version: push.number, platform: next.platform, active: receipt.active })
    return { deployment: await this.viewOf(next, kept), active: receipt.active, error: receipt.error }
  }

  /**
   * The record of a deployment whose container runs with these secrets. The
   * platform runs a container when there is none, when it stopped, and when
   * its env vars or its address must change; it keeps the volume each time.
   */
  private async container(platform: AppPlatform, app: AppRecord, request: PublishChoices, existing: DeploymentRecord | null, key: string, secrets: { app: AppSecretValues; webhooks: AppSecretValues }, version: number, at: number): Promise<DeploymentRecord> {
    const place: DeploymentPlace = request
    const secretsDigest = envDigest(secrets.app, secrets.webhooks)
    const isCurrent = existing !== null && existing.tailscaleAddress === request.tailscaleAddress && existing.secretsDigest === secretsDigest
    if (existing && isCurrent && (await platform.status(app.id)).running) return existing
    const spec = await this.spec(app, request, key, secrets.app, secrets.webhooks)
    const readiness = await platform.readiness(spec)
    if (!readiness.ready) throw new Error(readiness.problem)
    const endpoint = await platform.run(spec)
    return {
      appId: app.id, ...place, hostLabel: request.hostLabel,
      tailscaleAddress: request.tailscaleAddress, access: request.access, role: request.role,
      subjects: existing?.subjects ?? [], signIn: existing?.signIn ?? null, webhooks: existing?.webhooks ?? [],
      origin: endpoint.origin, address: endpoint.address, version: existing?.version ?? version, secretsDigest,
      createdAt: existing?.createdAt ?? at, publishedAt: existing?.publishedAt ?? at,
    }
  }

  /**
   * The access that goes to the deployment with a version. With `people`,
   * Solus Cloud gets the address and the list first, and the deployment gets
   * where it sends a visitor to sign in. With another access, a list that
   * Solus Cloud has for the copy goes: no person can sign in to it then.
   * The record `current` takes what Solus Cloud gave.
   */
  private async accessOf(app: AppRecord, current: DeploymentRecord, request: PublishChoices, linkSecret: string): Promise<AppAccess> {
    const access: AppAccess = { mode: request.access, role: request.role, linkSecret }
    if (request.access === 'people') {
      if (!this.options.signIn) throw new Error('This Solus has no account to sign people in with.')
      current.signIn = await this.options.signIn.setAccess(app.id, { slug: app.slug, address: current.address, subjects: request.subjects })
      access.signIn = current.signIn
    } else if (current.signIn) {
      await this.options.signIn?.removeAccess(app.id).catch((error) => log.warn('app_sign_in_remove_failed', { appId: app.id, error: error instanceof Error ? error.message : String(error) }))
      current.signIn = null
    }
    return access
  }

  /**
   * Removes the container and then the record. With `mustRemove`, a container
   * that was not removed keeps its record: the owner can try again when the
   * place answers. Without it the record goes in each case, as when the app
   * itself is gone.
   */
  private async discard(place: DeploymentPlace & Pick<DeploymentRecord, 'appId' | 'signIn'>, mustRemove = false): Promise<void> {
    const { appId } = place
    const removed = this.platformOf(place).then((platform) => platform.remove(appId))
    if (mustRemove) await removed
    else await removed.catch((error) => log.warn('app_deployment_remove_failed', { appId, error: error instanceof Error ? error.message : String(error) }))
    // A copy that is gone signs nobody in: Solus Cloud forgets its list.
    if (place.signIn) await this.options.signIn?.removeAccess(appId).catch((error) => log.warn('app_sign_in_remove_failed', { appId, error: error instanceof Error ? error.message : String(error) }))
    await rm(this.file(appId), { force: true })
    secretStore().remove(`app-deployment-${appId}`, this.secretsPath(appId))
    this.keyDigests = null
    emitAppActivity(appId, 'deployment')
  }

  private async viewOf(record: DeploymentRecord, stored: StoredSecrets): Promise<AppDeploymentView> {
    const platform = await this.platformOf(record).catch(() => null)
    const container = platform ? await platform.status(record.appId).catch(() => null) : null
    const running = container?.running ?? false
    const status = platform && running ? await this.clientOf(platform, record, stored.key).status().catch(() => null) : null
    return {
      platform: record.platform,
      host: record.hostId === null ? null : { id: record.hostId, label: record.hostLabel ?? record.hostId, isReachable: container !== null },
      tailscaleAddress: record.tailscaleAddress,
      access: record.access,
      role: record.role,
      subjects: record.subjects,
      webhooks: record.webhooks.map((name) => ({ name, url: `${record.address}${APP_WEBHOOK_PATH_PREFIX}${name}` })),
      address: record.address,
      link: record.access === 'link' ? `${record.address}/#${stored.linkSecret}` : record.address,
      version: record.version,
      publishedAt: record.publishedAt,
      createdAt: record.createdAt,
      running,
      status,
    }
  }

  /** The deployment of an app, as its owner sees it; null for an app that is not published. */
  async view(authority: AppAuthority, idOrSlug: string): Promise<AppDeploymentView | null> {
    const app = await this.apps.record(authority, idOrSlug)
    const record = await this.record(app.id)
    const stored = record ? this.secretsOf(app.id) : null
    return record && stored ? this.viewOf(record, stored) : null
  }

  /** The newest lines of the deployment's own log. */
  async logs(authority: AppAuthority, idOrSlug: string, lines: number): Promise<string> {
    const app = await this.apps.record(authority, idOrSlug)
    const record = await this.record(app.id)
    if (!record) throw new Error('This app is not published.')
    return (await this.platformOf(record)).logs(app.id, lines)
  }

  /** Removes the deployment of an app with the data it holds. The app in Solus does not change. */
  async unpublish(authority: AppAuthority, idOrSlug: string): Promise<void> {
    const app = await this.apps.record(authority, idOrSlug)
    const record = await this.record(app.id)
    if (!record) return
    // A container on another host that does not answer would run on with no record here: the owner connects the host first.
    await this.discard(record, record.hostId !== null)
    log.info('app_unpublished', { appId: app.id })
  }

  /**
   * Writes the build context of a self-contained image of the active version
   * into a folder (§8.4): the runtime image with the version in it. A person
   * builds it and runs it on a platform that Solus has no adapter for. The
   * image has no secret of the app in it: the README names each env var.
   */
  async exportImage(authority: AppAuthority, idOrSlug: string, folder: string): Promise<{ folder: string; version: number; env: string[] }> {
    const { app, push, secrets } = await this.apps.published(authority, idOrSlug)
    const env = Object.keys(secrets).map(appSecretEnvName)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'version.json'), JSON.stringify(push))
    await writeFile(join(folder, 'Dockerfile'), [
      `# ${app.slug}, version ${push.number}: a self-contained image of a Solus app (docs/plans/app-deploy.md).`,
      `FROM ${this.options.runtimeImage()}`,
      'COPY --chown=node:node version.json /app/version.json',
      `ENV ${APP_DEPLOYMENT_ENV.versionFile}=/app/version.json`,
      '',
    ].join('\n'))
    await writeFile(join(folder, 'README.md'), [
      `# ${app.slug}, version ${push.number}`,
      '',
      'Build and run:',
      '',
      '```sh',
      `docker build -t ${app.slug}:${push.number} .`,
      `docker run -d -p 8080:8080 -v ${app.slug}-data:/data -e ${APP_DEPLOYMENT_ENV.linkSecret}=<43 characters> ${env.map((name) => `-e ${name}=<value> `).join('')}${app.slug}:${push.number}`,
      '```',
      '',
      `- The app is private: open it at \`http://<address>/#<the link secret>\`. Set \`${APP_DEPLOYMENT_ENV.access}=public\` to answer each person.`,
      `- \`${APP_DEPLOYMENT_ENV.role}=viewer\` lets a visitor run queries only.`,
      '- The data is in the volume at `/data`.',
      '- This image has no Solus: a tool of an integration and a signal do not work in it.',
      ...(env.length ? ['- The app declares these secrets: ' + env.map((name) => `\`${name}\``).join(', ') + '.'] : []),
      '',
    ].join('\n'))
    log.info('app_image_exported', { appId: app.id, version: push.number })
    return { folder, version: push.number, env }
  }

  /** A new version in Solus does not reach the deployment by itself: a publish is its own act. */
  async activated(): Promise<void> {}

  /** A deleted app leaves no deployment that runs. */
  async removed(app: AppRecord): Promise<void> {
    const record = await this.record(app.id)
    if (record) await this.discard(record)
  }

  /** The app that an app key names and the version it has there; null for a key of no deployment of this Solus. A key of a removed deployment names none. */
  async publishedOfKey(key: string): Promise<{ appId: string; version: number } | null> {
    if (!appKeySchema.safeParse(key).success) return null
    if (!this.keyDigests) {
      const digests = new Map<string, Buffer>()
      for (const entry of await readdir(this.root()).catch(() => [])) {
        const appId = entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : null
        const stored = appId ? this.secretsOf(appId) : null
        if (appId && stored) digests.set(appId, digest(stored.key))
      }
      this.keyDigests = digests
    }
    const asked = digest(key)
    for (const [appId, stored] of this.keyDigests) {
      if (!timingSafeEqual(stored, asked)) continue
      const record = await this.record(appId)
      return record ? { appId, version: record.version } : null
    }
    return null
  }
}
