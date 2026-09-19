import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import type { IpcContext } from '@solus/contracts/types'
import { codeIntelStore } from '../../code-intel/code-intel.store.svelte'
import type { CodeSymbolHit } from '../../code-intel/lib/hit-test'
import { symbolAvailability, type CodeSymbolAvailability, type CodeSymbolLookup } from '../../code-intel/lib/symbol-card'

interface FileSymbolTarget {
  api: HostApi
  ctx: IpcContext
  cwd: string
  path: string | null
}

export class FileSymbols {
  lookup = $state<CodeSymbolLookup | null>(null)

  constructor(private target: () => FileSymbolTarget) {}

  private lookupFor(hit: CodeSymbolHit): CodeSymbolLookup | null {
    const { api, ctx, cwd, path } = this.target()
    // The host returns absolute display paths for files outside the project.
    if (!path || path.startsWith('/')) return null
    return {
      serverId: serverConnections.serverIdForApi(api), api, ctx,
      root: cwd, path: path.replaceAll('\\', '/'),
      line: hit.line - 1, character: hit.character, token: hit.token, anchor: hit.anchor,
    }
  }

  hit = (hit: CodeSymbolHit) => {
    this.lookup = this.lookupFor(hit)
  }

  availability = async (hit: CodeSymbolHit): Promise<CodeSymbolAvailability> => {
    const lookup = this.lookupFor(hit)
    if (!lookup) return 'none'
    try {
      return symbolAvailability(await codeIntelStore.symbolAt(lookup.serverId, lookup.api, lookup.ctx, {
        cwd: lookup.root, path: lookup.path, line: lookup.line, character: lookup.character,
      }))
    } catch {
      return 'none'
    }
  }
}
