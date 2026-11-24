import { randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseFlags } from '@solus/contracts/entrypoint'
import { formatCheckCode, normalizeCheckCode, PAIR_APPROVAL_TTL_MS, type PairApprovalDecision, type PairApprovalRequest } from '@solus/contracts/add-machine'
import type { HostListing } from '@solus/contracts/host-list'
import type { HostPairRequest, HostPairingsSnapshot } from '@solus/contracts/host-pairing'
import { normalizeServerUrl, parsePairLink } from '@solus/client-core/pairing'
import { requireRunningServerUrl, withLocalRpc } from './local-rpc'
import { defaultDataDir, runtimePaths } from './runtime'

function hostListText(snapshot: HostPairingsSnapshot): string {
  return snapshot.hosts.map(({ listing: host }) => `${host.label} (${host.installationId})\n  ${host.routes.map((route) => route.url).join(', ')}`).join('\n') || 'No paired hosts.'
}

function approvalListText(approvals: PairApprovalRequest[], now = Date.now()): string {
  return approvals.map((request) => `${request.checkCode}  ${request.deviceLabel}  from ${request.fromAddress}  expires in ${Math.max(0, Math.ceil((request.expiresAt - now) / 60_000))} min`).join('\n') || 'No approval requests.'
}

/** `solus host approvals`, `approve`, and `deny`: the open approval requests of the running server. */
async function runApprovalCommand(serverUrl: string, command: 'approvals' | 'approve' | 'deny', positional: string[], json: boolean): Promise<string> {
  if (command === 'approvals') {
    if (positional.length) throw new Error('Usage: solus host approvals [--json]')
    const approvals = await withLocalRpc<PairApprovalRequest[]>(serverUrl, (call) => call('hostsPairApprovals'))
    return json ? JSON.stringify(approvals) : approvalListText(approvals)
  }
  if (positional.length !== 1) throw new Error(`Usage: solus host ${command} <check-code>`)
  return decideByCheckCode(serverUrl, positional[0]!, command)
}

/** Approves or denies the one open request with this check code. */
async function decideByCheckCode(serverUrl: string, typed: string, decision: PairApprovalDecision): Promise<string> {
  const checkCode = normalizeCheckCode(typed)
  if (!checkCode) throw new Error(`"${typed}" is not a check code. A check code has 8 letters and digits, as XXXX-XXXX.`)
  return withLocalRpc(serverUrl, async (call) => {
    const matches = (await call<PairApprovalRequest[]>('hostsPairApprovals')).filter((request) => request.checkCode === checkCode)
    if (!matches.length) throw new Error(`No open approval request has the check code ${checkCode}.`)
    if (matches.length > 1) throw new Error(`More than one open request has the check code ${checkCode}. Decide in Settings → Connections → Access.`)
    const request = matches[0]!
    if (!(await call<boolean>('hostsPairApprovalDecide', [request.requestId, decision]))) throw new Error('That request is no longer open.')
    return `${decision === 'approve' ? 'Approved' : 'Denied'} ${request.deviceLabel} (${checkCode}).`
  })
}

/** A pairing code or link when one is given; with none, an approval request with a new check code, printed. */
function pairRequestOf(url: string, options: { code: string; codeFile: string; label: string }, log: (line: string) => void): HostPairRequest {
  let request: HostPairRequest
  if (options.code || options.codeFile) {
    const value = options.codeFile ? readFileSync(options.codeFile, 'utf8').trim() : options.code
    const link = parsePairLink(value)
    if (link && link.url !== url) throw new Error('The pairing link names a different server.')
    // The whole value goes: the host checks its shape (6 digits or a pair link) before it sends anything.
    request = { url, code: value }
  } else {
    // The owner of that host approves the request when its check code matches this one.
    request = { url, checkCode: formatCheckCode(randomInt) }
    log(`Asked ${url} to approve this host. Check code: ${request.checkCode}`)
    log(`On that host, approve the request with this check code, or run \`solus host approve ${request.checkCode}\` there. It expires in ${PAIR_APPROVAL_TTL_MS / 60_000} minutes.`)
  }
  if (options.label) request.label = options.label
  return request
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
  if (command === 'approvals' || command === 'approve' || command === 'deny') {
    log(await runApprovalCommand(serverUrl, command, positional, options.json))
    return
  }
  if (command === 'remove') {
    if (positional.length !== 1) throw new Error('Usage: solus host remove <installation-id>')
    const result = await withLocalRpc<{ removed: boolean }>(serverUrl, (call) => call('hostsForget', [positional[0]]))
    log(options.json ? JSON.stringify(result) : result.removed ? 'Host forgotten.' : 'Host was already absent.')
    return
  }
  if (command !== 'pair' || positional.length !== 1 || (options.code && options.codeFile)) {
    throw new Error('Usage: solus host pair <url> [--code CODE | --code-file PATH] [--label NAME]')
  }
  const request = pairRequestOf(normalizeServerUrl(positional[0]!), options, log)
  // An approval request waits for a person, so the call may take until the request expires.
  const timeoutMs = request.checkCode ? PAIR_APPROVAL_TTL_MS + 30_000 : undefined
  const host = await withLocalRpc<HostListing>(serverUrl, (call) => call('hostsPair', [request], timeoutMs))
  log(options.json ? JSON.stringify(host) : `Paired with ${host.label} (${host.installationId}).`)
}
