/**
 * `solus policy check` and `solus policy show` (plans/030 §7): validate a
 * `policy.json` before it is installed, and tell an administrator whether the
 * running host loaded the installed MDM policy.
 */
import { readFileSync } from 'fs'
import { z } from 'zod'
import type { PolicyDocument, ProviderLaunchPin } from '@solus/contracts/policy'
import { decodeMdmPolicy, MdmPolicyError, readMdmPolicy, type MdmPolicy } from '@solus/server/host/policy/mdm-policy'
import { requireRunningServerUrl, withLocalRpc } from './local-rpc'
import type { RuntimePaths } from './runtime'

type Log = (line: string) => void

/** Prints what the policy in `file` does, or why it is refused. Returns the exit code. */
export function checkPolicyFile(file: string, log: Log): number {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    log(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  let policy: MdmPolicy
  try {
    policy = decodeMdmPolicy(file, text)
  } catch (error) {
    if (!(error instanceof MdmPolicyError)) throw error
    log(`${file} is not a valid policy:`)
    for (const issue of error.reason.split('; ')) log(`  ${issue}`)
    return 1
  }
  log(`${file} is a valid policy (fingerprint ${policy.fingerprint}).`)
  for (const line of describePolicy(policy.document)) log(line)
  return 0
}

/** A plain summary of what a valid document locks and limits. */
export function describePolicy(document: PolicyDocument): string[] {
  const lines = [`Organization: ${document.organization.name}`]
  if (document.name) lines.push(`Name: ${document.name}`)
  if (document.revision !== undefined) lines.push(`Revision: ${document.revision}`)
  if (document.supportUrl) lines.push(`Support: ${document.supportUrl}`)

  const host = Object.entries(document.host ?? {}).filter(([, value]) => value !== undefined)
  lines.push(host.length ? 'Host settings (locked on this machine):' : 'Host settings: none locked.')
  for (const [key, value] of host) lines.push(`  ${key}: ${formatValue(value)}`)

  const settings = Object.entries(document.sessions?.settings ?? {}).filter(([, value]) => value !== undefined)
  lines.push(settings.length ? 'Session settings (locked):' : 'Session settings: none locked.')
  for (const [key, value] of settings) lines.push(`  ${key}: ${formatValue(value)}`)

  const limits = document.sessions?.limits
  const limitLines: string[] = []
  if (limits?.maxPermissionMode) limitLines.push(`  Highest permission mode: ${limits.maxPermissionMode}`)
  if (limits?.providers?.allowed) limitLines.push(`  Allowed providers: ${limits.providers.allowed.join(', ')}`)
  for (const [provider, pin] of Object.entries(limits?.providers?.launch ?? {})) {
    if (pin) limitLines.push(`  Launch pins for ${provider}: ${describeLaunchPin(pin)}`)
  }
  for (const [provider, models] of Object.entries(limits?.models ?? {})) {
    if (models) limitLines.push(`  Allowed models for ${provider}: ${models.join(', ')}`)
  }
  if (limits?.insights) limitLines.push(`  Send all Insights of organization sessions: ${limits.insights.syncAll ? 'yes' : 'no'}`)
  if (limits?.webhooks) limitLines.push(`  Unverified webhooks can start work: ${limits.webhooks.allowUnverified ? 'yes' : 'no'}`)
  lines.push(limitLines.length ? 'Session limits:' : 'Session limits: none.', ...limitLines)
  return lines
}

/** Environment values can hold tokens, so only their names are printed. */
function describeLaunchPin(pin: ProviderLaunchPin): string {
  const parts: string[] = []
  if (pin.environment?.length) parts.push(`environment ${pin.environment.map((entry) => entry.name).join(', ')}`)
  if (pin.binaryPath) parts.push(`binary ${pin.binaryPath}`)
  if (pin.launchArgs) parts.push(`arguments ${pin.launchArgs}`)
  return parts.join('; ') || 'none'
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** The `policy` field of `connectionsGetServerInfo`; parsed, because an older host does not send it. */
const hostPolicyInfoSchema = z.object({
  mdmFingerprint: z.string().nullable(),
  mdmSource: z.string().nullable(),
  cloud: z.array(z.object({ organizationId: z.string(), kind: z.string(), revision: z.number() })),
})
export type HostPolicyInfo = z.infer<typeof hostPolicyInfoSchema>

export interface PolicyShowDeps {
  readInstalled(): Promise<MdmPolicy | null>
  /** The running host's report, or null when the host does not report policy. Throws when no host runs. */
  readHost(): Promise<HostPolicyInfo | null>
}

export function systemPolicyShowDeps(paths: RuntimePaths): PolicyShowDeps {
  return {
    readInstalled: () => readMdmPolicy(),
    readHost: async () => {
      const info = await withLocalRpc<{ policy?: unknown }>(requireRunningServerUrl(paths), (call) => call('connectionsGetServerInfo'))
      const parsed = hostPolicyInfoSchema.safeParse(info?.policy)
      return parsed.success ? parsed.data : null
    },
  }
}

/** Prints the installed MDM policy and what the running host enforces. Returns the exit code. */
export async function showPolicy(deps: PolicyShowDeps, log: Log): Promise<number> {
  let installed: MdmPolicy | null
  let exitCode = 0
  try {
    installed = await deps.readInstalled()
  } catch (error) {
    if (!(error instanceof MdmPolicyError)) throw error
    log(error.message)
    installed = null
    exitCode = 1
  }
  if (installed) {
    log(`MDM policy: ${installed.source}`)
    log(`  Organization: ${installed.document.organization.name}`)
    log(`  Fingerprint: ${installed.fingerprint}`)
  } else if (exitCode === 0) {
    log('No MDM policy is installed.')
  }

  let host: HostPolicyInfo | null
  try {
    host = await deps.readHost()
  } catch (error) {
    log(`Could not ask the running host: ${error instanceof Error ? error.message : String(error)}`)
    return exitCode || 1
  }
  if (!host) {
    log('The running host does not report its policy. Update Solus.')
    return exitCode || 1
  }
  const installedFingerprint = installed?.fingerprint ?? null
  if (host.mdmFingerprint === installedFingerprint) {
    if (installedFingerprint) log('The running host enforces this policy.')
  } else {
    log(host.mdmFingerprint
      ? `The running host enforces a different MDM policy (fingerprint ${host.mdmFingerprint}, from ${host.mdmSource ?? 'an unknown source'}).`
      : 'The running host enforces no MDM policy.')
    log('Restart Solus to apply the installed policy.')
  }

  if (host.cloud.length === 0) {
    log('Cloud policies: none.')
  } else {
    log('Cloud policies:')
    for (const policy of host.cloud) log(`  ${policy.organizationId}: ${policy.kind} policy, revision ${policy.revision}`)
  }
  return exitCode
}
