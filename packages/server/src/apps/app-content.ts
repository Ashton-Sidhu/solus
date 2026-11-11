import { z } from 'zod'
import { appBundleSchema, appBundleSourceText, type AppBundle } from '@solus/contracts/apps'
import { appSourceProblem, compileAppComponent, extractAppRoles } from './app-source'

/**
 * An app's content (docs/plans/apps.md §3): one component the server compiles,
 * or the bundle an app project builds. This is the one place that knows both
 * forms. Pure: no store, so it is tested as text.
 */
export type AppContent = { kind: 'component'; code: string } | { kind: 'bundle'; bundle: AppBundle }

/** A body that says it is a bundle and is not a valid one. */
export class AppContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppContentError'
  }
}

/** A bundle is a JSON object that says so; every other body is a component. */
const bundleMarkerSchema = z.object({ solusApp: z.number() })

export function readAppContent(content: string): AppContent {
  if (!content.trimStart().startsWith('{')) return { kind: 'component', code: content }
  let marked: boolean
  let bundle: ReturnType<typeof appBundleSchema.safeParse>
  try {
    const json = z.json().parse(JSON.parse(content))
    marked = bundleMarkerSchema.safeParse(json).success
    bundle = appBundleSchema.safeParse(json)
  } catch {
    return { kind: 'component', code: content }
  }
  if (!marked) return { kind: 'component', code: content }
  if (!bundle.success) {
    const issue = bundle.error.issues[0]
    throw new AppContentError(`The app bundle is not valid: ${issue ? `${issue.path.join('.') || 'bundle'}: ${issue.message}` : 'unknown shape'}. Build it with \`npm run bundle\` in the app project.`)
  }
  return { kind: 'bundle', bundle: bundle.data }
}

/** Why a body cannot be an app's content, or null when it can. Every write of an `app` work passes here. */
export function appContentProblem(content: string): string | null {
  try {
    const read = readAppContent(content)
    return read.kind === 'component' ? appSourceProblem(read.code) : null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The integration slugs the app names: read from a component's source, listed by a bundle's build. */
export function appRoles(content: AppContent): string[] {
  return content.kind === 'component' ? extractAppRoles(content.code) : content.bundle.integrations
}

/** The CommonJS module body the shell runs in the frame. */
export function appClientModule(content: AppContent): string {
  return content.kind === 'component' ? compileAppComponent(content.code) : content.bundle.client
}

/** The CommonJS module the runner loads on the host, when the app has host functions. */
export function appServerModule(content: AppContent): string | null {
  return content.kind === 'bundle' ? content.bundle.server ?? null : null
}

const KIB = 1024

/**
 * An app's content as an agent reads it. A component is its own source. A
 * bundle is megabytes of compiled code, so the agent gets its sources and
 * what it holds, never the compiled text.
 */
export function describeAppContent(content: string): string {
  let read: AppContent
  try {
    read = readAppContent(content)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (read.kind === 'component') return content
  const { bundle } = read
  const facts = [
    `client ${Math.ceil(bundle.client.length / KIB)} KiB`,
    bundle.server ? `host functions ${Math.ceil(bundle.server.length / KIB)} KiB` : 'no host functions',
    bundle.integrations.length ? `integrations ${bundle.integrations.join(', ')}` : 'no integrations',
  ].join('; ')
  const files = appBundleSourceText(bundle)
  const head = `This app is a bundle built from an app project (${facts}). The compiled code is not shown.`
  if (!files) return `${head} The bundle carries no sources: revise it from its project folder, or make the project again with the apps skill.`
  return `${head} To revise it, put these sources in an app project (apps skill), change them, run \`npm run bundle\`, and call create_app with work_id and path.\n\n${files}`
}
