import { describeAppHostAccess, readAppPage, type AppAllowedHostAccess, type AppHostAccess, type AppHostAccessState, type AppPermissions } from '@solus/contracts/apps'
import { appServerHash } from './app-content'
import type { UpstreamTool } from '../integrations/gateway'

/** Whether the app's own permissions admit an integration tool (docs/plans/apps.md §5). Pure, so it is tested as data. */
export function admits(permissions: Pick<AppPermissions, 'tools'>, name: string, tool: Pick<UpstreamTool, 'annotations'> | undefined): boolean {
  if (permissions.tools === 'all') return true
  if (permissions.tools === 'read-only') return tool?.annotations?.readOnlyHint === true
  return permissions.tools.selected.includes(name)
}

/**
 * What an app asks of the host (§6): host functions when its manifest has a
 * server module, integration writes that do not ask when its permissions say
 * so, and its network hosts and file paths. File paths mean nothing without
 * host functions, so they are not asked for.
 */
export function hostAccessAsked(permissions: Pick<AppPermissions, 'writes' | 'network' | 'files'>, hasFunctions: boolean): AppHostAccess {
  return {
    functions: hasFunctions,
    writes: permissions.writes === 'allow',
    network: permissions.network,
    files: hasFunctions ? permissions.files : { read: [], write: [] },
  }
}

/** An app that asks for nothing needs no decision. */
export function hostAccessIsEmpty(access: AppHostAccess): boolean {
  return !access.functions && !access.writes && access.network.length === 0
}

function listCovers(allowed: readonly string[], asked: readonly string[]): boolean {
  return allowed.includes('*') || asked.every((entry) => allowed.includes(entry))
}

/** Whether what the owner allowed covers what the app asks now: a wider request asks again, a narrower one does not. */
export function hostAccessCovers(allowed: AppHostAccess, asked: AppHostAccess): boolean {
  return (allowed.functions || !asked.functions)
    && (allowed.writes || !asked.writes)
    && listCovers(allowed.network, asked.network)
    && listCovers(allowed.files.read, asked.files.read)
    && listCovers(allowed.files.write, asked.files.write)
}

/**
 * Whether what the app asks is in force (§6). The owner allowed a host access
 * for the host code as it was: a wider request asks again, and so does host
 * code that changed, whoever changed it.
 */
export function hostAccessState(asks: AppHostAccess, serverHash: string | null, allowed: AppAllowedHostAccess | undefined): AppHostAccessState {
  if (hostAccessIsEmpty(asks)) return 'none'
  if (!allowed || !hostAccessCovers(allowed.access, asks)) return 'pending'
  return !asks.functions || allowed.serverHash === serverHash ? 'allowed' : 'pending'
}

/**
 * What a tool's receipt says of a saved page's host access (§6): what the app
 * still waits for, or nothing when the page is not an app or waits for
 * nothing. The agent's only word that the owner must allow the app.
 */
export function hostAccessReceiptNote(html: string, allowed: AppAllowedHostAccess | undefined): string {
  const page = readAppPage(html)
  if (page.kind !== 'app') return ''
  const asks = hostAccessAsked(page.manifest.permissions, page.manifest.server !== undefined)
  if (hostAccessState(asks, appServerHash(page.manifest), allowed) !== 'pending') return ''
  return ` It asks to ${describeAppHostAccess(asks)}. Tell the user to allow that in the app's header: until then, those parts of the app do not work.`
}
