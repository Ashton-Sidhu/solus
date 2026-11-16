import type { AppDeployPreflight, AppDescriptor, AppNameChanges } from '@solus/contracts/apps'
import { listVersions, loadVersion, type AppRecord } from '../data/apps/app-store'
import { AppBuildError, type AppBuilder } from './app-builder'
import type { AppRepositories } from './app-repository'
import { readAppSecrets, type AppSecretValues } from './app-secrets'
import type { AppAuthority, AppLifecyclePart, Apps } from './apps'

/**
 * The deploy preflight (docs/plans/apps.md §9.2): what a deploy of one
 * revision changes against the active version, before the owner deploys it.
 * What a revision declares is known only from its build, so the host builds
 * the revision in the app's build folder (one build at a time, as a deploy
 * does) and makes no version of it. A revision that a version was built from
 * gives that version's descriptor, with no build. A revision does not change,
 * so the host keeps what it read of each one.
 */

export interface AppDeployPreflightDeps {
  apps: Pick<Apps, 'record'>
  builder: Pick<AppBuilder, 'buildRevision'>
  repositories: Pick<AppRepositories, 'hasRevision' | 'checkout'>
}

/** What the build of a revision declares, or why the build failed. */
type RevisionDeclaration = { descriptor: AppDescriptor } | { buildError: string }

/** The revisions whose declaration the host keeps, over all apps. */
const KEPT_DECLARATIONS = 64

function nameChanges(before: readonly string[], after: readonly string[]): AppNameChanges {
  const old = new Set(before)
  const next = new Set(after)
  return { added: after.filter((name) => !old.has(name)), removed: before.filter((name) => !next.has(name)) }
}

function names(entries: readonly { name: string }[]): string[] {
  return entries.map((entry) => entry.name)
}

/** What a descriptor declares, as the lists a preflight compares. */
function declared(descriptor: AppDescriptor) {
  return {
    network: descriptor.permissions.network,
    readPaths: descriptor.permissions.files.read,
    writePaths: descriptor.permissions.files.write,
    models: descriptor.config.filter((field) => field.type === 'model').map((field) => field.name),
    integrations: descriptor.integrations,
    operations: names(descriptor.operations),
    workflows: names(descriptor.workflows),
    schedules: names(descriptor.schedules),
    webhooks: names(descriptor.webhooks),
    signals: names(descriptor.signals),
  }
}

type DeclaredLists = ReturnType<typeof declared>

const NOTHING_DECLARED: DeclaredLists = { network: [], readPaths: [], writePaths: [], models: [], integrations: [], operations: [], workflows: [], schedules: [], webhooks: [], signals: [] }

/** What `next` changes against `live`, the active version's descriptor; with no active version, everything is new. */
export function deployPreflight(commit: string, against: { number: number; descriptor: AppDescriptor } | null, declaration: RevisionDeclaration, secrets: AppSecretValues): AppDeployPreflight {
  const isBuilt = 'descriptor' in declaration
  // A revision that does not build declares nothing the host can read: nothing is named as a change.
  const before = against && isBuilt ? declared(against.descriptor) : NOTHING_DECLARED
  const after = isBuilt ? declared(declaration.descriptor) : before
  return {
    commit,
    against: against?.number ?? null,
    buildError: isBuilt ? null : declaration.buildError,
    network: nameChanges(before.network, after.network),
    readPaths: nameChanges(before.readPaths, after.readPaths),
    writePaths: nameChanges(before.writePaths, after.writePaths),
    models: nameChanges(before.models, after.models),
    integrations: nameChanges(before.integrations, after.integrations),
    operations: nameChanges(before.operations, after.operations),
    workflows: nameChanges(before.workflows, after.workflows),
    schedules: nameChanges(before.schedules, after.schedules),
    webhooks: nameChanges(before.webhooks, after.webhooks),
    signals: nameChanges(before.signals, after.signals),
    secretsMissing: isBuilt ? declaration.descriptor.secrets.filter((secret) => !secrets[secret.name]).map((secret) => ({ name: secret.name, label: secret.label })) : [],
  }
}

export class AppDeployPreflights implements AppLifecyclePart {
  /** `<app id>/<commit>`: what the revision declares. A read in progress is kept too, so two asks build once. */
  private readonly declarations = new Map<string, Promise<RevisionDeclaration>>()

  constructor(private readonly deps: AppDeployPreflightDeps, private readonly secretsOf: (appId: string) => AppSecretValues = readAppSecrets) {}

  async preflight(authority: AppAuthority, idOrSlug: string, commit: string): Promise<AppDeployPreflight> {
    const app = await this.deps.apps.record(authority, idOrSlug)
    if (!(await this.deps.repositories.hasRevision(app.repository, commit))) throw new Error('This app has no such revision.')
    const active = app.activeVersion === null ? null : await loadVersion(app.id, app.activeVersion)
    const declaration = await this.declarationOf(app, commit)
    return deployPreflight(commit, active ? { number: active.number, descriptor: active.descriptor } : null, declaration, this.secretsOf(app.id))
  }

  async activated(): Promise<void> {}

  async removed(app: AppRecord): Promise<void> {
    for (const key of this.declarations.keys()) if (key.startsWith(`${app.id}/`)) this.declarations.delete(key)
  }

  private declarationOf(app: AppRecord, commit: string): Promise<RevisionDeclaration> {
    const key = `${app.id}/${commit}`
    const kept = this.declarations.get(key)
    if (kept) return kept
    const read = this.read(app, commit)
    this.declarations.set(key, read)
    // A read that threw is not kept: the next ask tries again.
    read.catch(() => this.declarations.delete(key))
    for (const oldest of this.declarations.keys()) {
      if (this.declarations.size <= KEPT_DECLARATIONS) break
      this.declarations.delete(oldest)
    }
    return read
  }

  private async read(app: AppRecord, commit: string): Promise<RevisionDeclaration> {
    const built = (await listVersions(app.id)).find((version) => version.sourceCommit === commit && version.buildCommit !== '')
    if (built) return { descriptor: built.descriptor }
    try {
      const result = await this.deps.builder.buildRevision(app.id, async (folder) => {
        await this.deps.repositories.checkout(app.repository, commit, folder)
      })
      return { descriptor: result.build.descriptor }
    } catch (error) {
      if (error instanceof AppBuildError) return { buildError: error.message }
      throw error
    }
  }
}
