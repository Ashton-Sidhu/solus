import { readFileSync } from 'node:fs'
import { parseFlags } from '@solus/contracts/entrypoint'
import type { HostListing } from '@solus/contracts/host-list'
import type { HostPairRequest, HostPairingsSnapshot } from '@solus/contracts/host-pairing'
import { normalizeServerUrl, parsePairLink } from '@solus/client-core/pairing'
import { requireRunningServerUrl, withLocalRpc } from './local-rpc'
import { defaultDataDir, runtimePaths } from './runtime'

function hostListText(snapshot: HostPairingsSnapshot): string {
  return snapshot.hosts.map(({ listing: host }) => `${host.label} (${host.installationId})\n  ${host.routes.map((route) => route.url).join(', ')}`).join('\n') || 'No paired hosts.'
}

/** Same host-owned pairing path as the chat tools. The CLI never opens the live database. */
export async function runHostCommand(argv: string[], log: (line: string) => void): Promise<void> {
  const [command, ...rest] = argv
  const options = { dataDir: defaultDataDir(), code: '', codeFile: '', label: '', json: false }
  const positional = rest[0] && !rest[0].startsWith('-') ? [rest.shift()!] : []
  parseFlags(rest, {
    '--data-dir': { value: (value) => { options.dataDir = value } },
    '--code': { value: (value) => { options.code = value } },
    '--code-file': { value: (value) => { options.codeFile = value } },
    '--label': { value: (value) => { options.label = value } },
    '--json': { set: () => { options.json = true } },
  }, (arg) => new Error(`Unknown host option: ${arg}`))
  const serverUrl = requireRunningServerUrl(runtimePaths(options.dataDir))
  if (command === 'list') {
    if (positional.length) throw new Error('Usage: solus host list [--json]')
    const result = await withLocalRpc<HostPairingsSnapshot>(serverUrl, (call) => call('hostsListPaired'))
    log(options.json ? JSON.stringify(result) : hostListText(result))
    return
  }
  if (command === 'remove') {
    if (positional.length !== 1) throw new Error('Usage: solus host remove <installation-id>')
    const result = await withLocalRpc<{ removed: boolean }>(serverUrl, (call) => call('hostsForget', [positional[0]]))
    log(options.json ? JSON.stringify(result) : result.removed ? 'Host forgotten.' : 'Host was already absent.')
    return
  }
  if (command !== 'pair' || positional.length !== 1 || !!options.code === !!options.codeFile) {
    throw new Error('Usage: solus host pair <url> (--code CODE | --code-file PATH) [--label NAME]')
  }
  const value = options.codeFile ? readFileSync(options.codeFile, 'utf8').trim() : options.code
  const link = parsePairLink(value)
  const url = normalizeServerUrl(positional[0]!)
  if (link && link.url !== url) throw new Error('The pairing link names a different server.')
  const request: HostPairRequest = { url, code: link?.pairToken ?? value }
  if (options.label) request.label = options.label
  const host = await withLocalRpc<HostListing>(serverUrl, (call) => call('hostsPair', [request]))
  log(options.json ? JSON.stringify(host) : `Paired with ${host.label} (${host.installationId}).`)
}
