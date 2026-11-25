import { randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseFlags } from '@solus/contracts/entrypoint'
import { formatCheckCode, normalizeCheckCode, PAIR_APPROVAL_TTL_MS, type PairApprovalDecision, type PairApprovalRequest } from '@solus/contracts/add-machine'
import type { HostListing } from '@solus/contracts/host-list'
import type { HostPairRequest, HostPairingsSnapshot } from '@solus/contracts/host-pairing'
import type { SshAddRequest, SshAddResult } from '@solus/contracts/remote-machines'
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

/** An install over SSH can take minutes: Solus downloads and starts there. */
const SSH_ADD_TIMEOUT_MS = 20 * 60 * 1000

/** What one SSH add means for the person at the terminal, and whether it added the machine. */
export interface SshAddReport {
  text: string
  isAdded: boolean
}

export function sshAddText(result: SshAddResult): SshAddReport {
  switch (result.status) {
    case 'forwarded': return { text: `Added ${result.host.label} (${result.host.installationId}) through an SSH forward.`, isAdded: true }
    case 'session':
    case 'linked': return { text: `Added ${result.label} (${result.installationId}).`, isAdded: true }
    case 'key-permissions': return { text: `${result.message}\nRun the command again with --fix-key-permissions to let only you read it.`, isAdded: false }
    case 'needs-auth': return { text: `${result.message}\nUse a key with --identity-file, or add the machine in the app to give a password.`, isAdded: false }
    case 'needs-target': return { text: `${result.message}\nTry: ${result.candidates.map((candidate) => candidate.target).join(', ') || result.defaultTarget}`, isAdded: false }
  }
}

/** Adds a machine over SSH from this host; with `fixKey`, the host first lets only its owner read the key. */
async function runSshAdd(serverUrl: string, sshTarget: string, options: { identityFile: string; fixKey: boolean; json: boolean }, log: (line: string) => void): Promise<void> {
  const request: SshAddRequest = { sshTarget, requestId: `cli-${randomInt(1e9)}`, deviceLabel: 'Solus CLI' }
  if (options.identityFile) request.identityFile = options.identityFile
  if (options.identityFile && options.fixKey) request.fixIdentityFilePermissions = true
  const result = await withLocalRpc<SshAddResult>(serverUrl, (call) => call<SshAddResult>('hostsAddOverSsh', [request], SSH_ADD_TIMEOUT_MS))
  const { text, isAdded } = sshAddText(result)
  log(options.json ? JSON.stringify(result) : text)
  if (!isAdded) process.exitCode = 1
}

/** The options of `solus host`, from its arguments after the command and its one positional value. */
function hostCommandOptions(rest: string[]) {
  const options = { dataDir: defaultDataDir(), code: '', codeFile: '', label: '', json: false, identityFile: '', fixKey: false }
  parseFlags(rest, {
    '--data-dir': { value: (value) => { options.dataDir = value } },
    '--code': { value: (value) => { options.code = value } },
    '--code-file': { value: (value) => { options.codeFile = value } },
    '--label': { value: (value) => { options.label = value } },
    '--json': { set: () => { options.json = true } },
    '--identity-file': { value: (value) => { options.identityFile = value } },
    '--fix-key-permissions': { set: () => { options.fixKey = true } },
  }, (arg) => new Error(`Unknown host option: ${arg}`))
  return options
}

/** Same host-owned pairing path as the chat tools. The CLI never opens the live database. */
export async function runHostCommand(argv: string[], log: (line: string) => void): Promise<void> {
  const [command, ...rest] = argv
  const positional = rest[0] && !rest[0].startsWith('-') ? [rest.shift()!] : []
  const options = hostCommandOptions(rest)
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
  if (command === 'add-ssh') {
    if (positional.length !== 1) throw new Error('Usage: solus host add-ssh <user@host | ssh-config alias> [--identity-file PATH] [--fix-key-permissions]')
    await runSshAdd(serverUrl, positional[0]!, options, log)
    return
  }
  if (command === 'remove') {
    if (positional.length !== 1) throw new Error('Usage: solus host remove <installation-id>')
    const result = await withLocalRpc<{ removed: boolean }>(serverUrl, (call) => call('hostsForget', [positional[0]]))
    log(options.json ? JSON.stringify(result) : result.removed ? 'Host forgotten.' : 'Host was already absent.')
    return
  }
  if (command !== 'pair') throw new Error('Usage: solus host pair <url> [--code CODE | --code-file PATH] [--label NAME]')
  await runPair(serverUrl, positional, options, log)
}

async function runPair(serverUrl: string, positional: string[], options: ReturnType<typeof hostCommandOptions>, log: (line: string) => void): Promise<void> {
  if (positional.length !== 1 || (options.code && options.codeFile)) {
    throw new Error('Usage: solus host pair <url> [--code CODE | --code-file PATH] [--label NAME]')
  }
  const request = pairRequestOf(normalizeServerUrl(positional[0]!), options, log)
  // An approval request waits for a person, so the call may take until the request expires.
  const timeoutMs = request.checkCode ? PAIR_APPROVAL_TTL_MS + 30_000 : undefined
  const host = await withLocalRpc<HostListing>(serverUrl, (call) => call('hostsPair', [request], timeoutMs))
  log(options.json ? JSON.stringify(host) : `Paired with ${host.label} (${host.installationId}).`)
}
