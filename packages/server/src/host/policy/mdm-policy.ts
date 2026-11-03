import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { promisify } from 'util'
import { canonicalPolicyJson, validatePolicyDocument, type PolicyDocument } from '@solus/contracts/policy'
import { isPackagedRuntime } from '../../platform/paths'
import { createLogger } from '../../logger'

const log = createLogger('main', 'mdm-policy')
const execFileAsync = promisify(execFile)

/**
 * The machine's MDM policy (plans/030 §5.1): a file, a macOS device profile, or a
 * Windows registry value that an administrator installs. Read once, when the host
 * starts. A policy the host cannot fully enforce stops the host instead of leaving it
 * looking managed.
 */
export interface MdmPolicy {
  /** Where it was read from, for errors and `solus policy show`. */
  source: string
  document: PolicyDocument
  fingerprint: string
}

export class MdmPolicyError extends Error {
  constructor(readonly source: string, readonly reason: string) {
    super(`The MDM policy at ${source} cannot be enforced: ${reason}. Run "solus policy check" on it.`)
    this.name = 'MdmPolicyError'
  }
}

export const MDM_POLICY_FILES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Library/Application Support/Solus/policy.json',
  win32: 'C:\\ProgramData\\Solus\\policy.json',
  linux: '/etc/solus/policy.json',
}
export const MDM_PROFILE_PLIST = '/Library/Managed Preferences/com.solus.app.plist'
export const MDM_REGISTRY_KEY = 'HKLM\\SOFTWARE\\Policies\\Solus'

/** What the reader touches, so tests run it without a machine policy. */
export interface MdmPolicyEnvironment {
  platform: NodeJS.Platform
  exists(path: string): boolean
  readFile(path: string): string
  /** A system tool's stdout; throws when it fails. */
  run(command: string, args: string[]): Promise<string>
  /** Dev builds only; release builds never read an override a user can set. */
  devOverridePath: string | null
}

export function systemMdmEnvironment(): MdmPolicyEnvironment {
  return {
    platform: process.platform,
    exists: existsSync,
    readFile: (path) => readFileSync(path, 'utf8'),
    run: async (command, args) => (await execFileAsync(command, args, { timeout: 10_000, windowsHide: true })).stdout,
    devOverridePath: isPackagedRuntime() ? null : process.env.SOLUS_DEV_POLICY_PATH || null,
  }
}

export function policyFingerprint(document: PolicyDocument): string {
  return createHash('sha256').update(canonicalPolicyJson(document)).digest('hex').slice(0, 12)
}

/** Decode raw JSON text from one source; refuses anything the validator refuses. */
export function decodeMdmPolicy(source: string, text: string): MdmPolicy {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    throw new MdmPolicyError(source, `it is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const result = validatePolicyDocument(input, 'mdm')
  if (!result.ok) throw new MdmPolicyError(source, result.issues.join('; '))
  return { source, document: result.document, fingerprint: policyFingerprint(result.document) }
}

/** The machine's MDM policy, or null when none is installed. Throws `MdmPolicyError` when one cannot be enforced. */
export async function readMdmPolicy(environment: MdmPolicyEnvironment = systemMdmEnvironment()): Promise<MdmPolicy | null> {
  if (environment.devOverridePath) {
    if (!environment.exists(environment.devOverridePath)) return null
    return decodeMdmPolicy(environment.devOverridePath, environment.readFile(environment.devOverridePath))
  }
  const found: Array<{ source: string; text: () => Promise<string> }> = []
  const file = MDM_POLICY_FILES[environment.platform]
  if (file && environment.exists(file)) found.push({ source: file, text: async () => environment.readFile(file) })
  if (environment.platform === 'darwin' && environment.exists(MDM_PROFILE_PLIST)) {
    found.push({ source: `configuration profile com.solus.app`, text: async () => withoutProfileKeys(await environment.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', MDM_PROFILE_PLIST])) })
  }
  if (environment.platform === 'win32') {
    const value = await readRegistryPolicy(environment)
    if (value !== null) found.push({ source: `${MDM_REGISTRY_KEY}\\Policy`, text: async () => value })
  }
  if (found.length === 0) return null
  if (found.length > 1) {
    throw new MdmPolicyError(found.map((entry) => entry.source).join(' and '), 'two MDM sources are installed; remove one')
  }
  const [only] = found
  let text: string
  try {
    text = await only.text()
  } catch (error) {
    throw new MdmPolicyError(only.source, `it cannot be read (${error instanceof Error ? error.message : String(error)})`)
  }
  const policy = decodeMdmPolicy(only.source, text)
  warnWhenUserWritable(only.source, environment)
  log.info('mdm_policy_loaded', { source: policy.source, fingerprint: policy.fingerprint, organization: policy.document.organization.name })
  return policy
}

let machinePolicy: Promise<MdmPolicy | null> | null = null

/** This process's MDM policy, read once: the boot and every early reader (telemetry) share the one read. */
export function loadMachinePolicy(): Promise<MdmPolicy | null> {
  machinePolicy ??= readMdmPolicy()
  return machinePolicy
}

/** A device profile adds its own `Payload*` keys beside the policy's; they are not policy keys. */
function withoutProfileKeys(json: string): string {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json
    return JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([key]) => !key.startsWith('Payload'))))
  } catch {
    return json
  }
}

/** `reg query` prints `    Policy    REG_SZ    <value>`; a missing key or value exits non-zero. */
async function readRegistryPolicy(environment: MdmPolicyEnvironment): Promise<string | null> {
  let stdout: string
  try {
    stdout = await environment.run('reg', ['query', MDM_REGISTRY_KEY, '/v', 'Policy'])
  } catch {
    return null
  }
  const match = stdout.match(/^\s*Policy\s+REG_SZ\s+(.*)$/m)
  return match ? match[1].trim() : null
}

function warnWhenUserWritable(source: string, environment: MdmPolicyEnvironment): void {
  if (environment.platform === 'win32' || !environment.exists(source)) return
  try {
    const stat = statSync(source)
    const writableByUser = typeof process.getuid === 'function' && stat.uid === process.getuid() && (stat.mode & 0o200) !== 0
    if (writableByUser || (stat.mode & 0o002) !== 0) log.warn('mdm_policy_user_writable', { source })
  } catch {
    // A profile path or a file that vanished: nothing to warn about.
  }
}
