import type { AppAllowedHostAccess, AppHostAccess, AppHostAccessState, AppPermissions } from '@solus/contracts/apps'
import type { UpstreamTool } from '../integrations/gateway'

/** Whether the app's own permissions admit an integration tool (docs/plans/apps.md §5). Pure, so it is tested as data. */
export function admits(permissions: Pick<AppPermissions, 'tools'>, name: string, tool: Pick<UpstreamTool, 'annotations'> | undefined): boolean {
  if (permissions.tools === 'all') return true
  if (permissions.tools === 'read-only') return tool?.annotations?.readOnlyHint === true
  return permissions.tools.selected.includes(name)
}

/**
 * What an app asks of the host (§6): host functions when its bundle has a
 * server module, and the network hosts and file paths of its permissions.
 * File paths mean nothing without host functions, so they are not asked for.
 */
export function hostAccessAsked(permissions: Pick<AppPermissions, 'network' | 'files'>, hasFunctions: boolean): AppHostAccess {
  return {
    functions: hasFunctions,
    network: permissions.network,
    files: hasFunctions ? permissions.files : { read: [], write: [] },
  }
}

/** An app that asks for nothing needs no decision. */
export function hostAccessIsEmpty(access: AppHostAccess): boolean {
  return !access.functions && access.network.length === 0
}

function listCovers(allowed: readonly string[], asked: readonly string[]): boolean {
  return allowed.includes('*') || asked.every((entry) => allowed.includes(entry))
}

/** Whether what the owner allowed covers what the app asks now: a wider request asks again, a narrower one does not. */
export function hostAccessCovers(allowed: AppHostAccess, asked: AppHostAccess): boolean {
  return (allowed.functions || !asked.functions)
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

/** The frame's `connect-src` for the app's network hosts: each as an HTTPS and a WSS origin. */
export function appConnectDomains(network: readonly string[]): string[] {
  if (network.includes('*')) return ['https:', 'wss:']
  return network.flatMap((host) => [`https://${host}`, `wss://${host}`])
}
