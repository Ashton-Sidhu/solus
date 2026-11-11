import { createHash } from 'node:crypto'
import { appSourceText, readAppPage, type AppManifest } from '@solus/contracts/apps'

/**
 * An app's page on the server (docs/plans/apps.md §3). `readAppPage` in the
 * contract is the one reader of a manifest; this module adds what only the
 * server needs of it. Pure: no store, so it is tested as text.
 */

/** The name of the host code the owner allows: changed code has another name. Null when the app has none. */
export function appServerHash(manifest: AppManifest): string | null {
  return manifest.server === undefined ? null : createHash('sha256').update(manifest.server).digest('hex')
}

const KIB = 1024

/**
 * A work's body as an agent reads it. An app's page is megabytes of built
 * code, so the agent gets what the app is and its sources. Any other body is
 * itself.
 */
export function describeAppContent(html: string): string {
  const read = readAppPage(html)
  if (read.kind !== 'app') return html
  const { manifest } = read
  const facts = [
    `page ${Math.ceil(html.length / KIB)} KiB`,
    manifest.server ? `host functions ${Math.ceil(manifest.server.length / KIB)} KiB` : 'no host functions',
    manifest.integrations.length ? `integrations ${manifest.integrations.join(', ')}` : 'no integrations',
  ].join('; ')
  const files = appSourceText(manifest)
  const head = `This artifact is an app built from a visual-artifacts project (${facts}). The built page is not shown.`
  if (!files) return `${head} It carries no sources: revise it from its project folder, or make the project again.`
  return `${head} To revise it, put these sources in a visual-artifacts project, change them, run \`npm run bundle\`, and call create_app with work_id and html_path.\n\n${files}`
}
