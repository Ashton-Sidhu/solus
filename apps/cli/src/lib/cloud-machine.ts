import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { hostRegistrationSchema, hostTunnelSchema, uplinkDesiredStateSchema, type HostRegistration, type HostTunnel } from '@solus/contracts/uplink'

/**
 * A cloud machine, as the command line sees it (plans/034-one-cloud-machine-kind.md).
 * A server becomes one when it registers with an organization code and its own HTTPS
 * address. After that it trusts nobody by network position, so its local socket
 * refuses this CLI. What the CLI can still say comes from the two non-secret records
 * the server keeps in its data directory: `host-registration.json`
 * (`packages/server/src/host/host-registration.ts`) and `host-link.json`
 * (`packages/server/src/transport/uplink/link.ts`). The server writes them to
 * `SOLUS_DATA_DIR`, which is the data directory this CLI starts it with.
 */

const registrationRecordSchema = z.object({ version: z.literal(1), registration: hostRegistrationSchema })
const linkRecordSchema = z.object({ version: z.literal(2), hostId: z.string().min(1), desired: uplinkDesiredStateSchema, tunnel: hostTunnelSchema })

export interface CloudMachineRecord {
  registration: HostRegistration & { organizationId: string }
  /** How the machine is reached: its own address and the port that address forwards to. Null until Solus cloud recorded the address. */
  tunnel: HostTunnel | null
}

/** One record of the data directory; null when it is absent or is not what the server writes. */
function readRecord<Schema extends z.ZodType>(file: string, schema: Schema): z.infer<Schema> | null {
  if (!existsSync(file)) return null
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The records of the cloud machine in `dataDir`; null when the server there is not one. */
export function readCloudMachineRecord(dataDir: string): CloudMachineRecord | null {
  const registration = readRecord(join(dataDir, 'host-registration.json'), registrationRecordSchema)?.registration
  const organizationId = registration?.organizationId
  if (!registration || !organizationId) return null
  const link = readRecord(join(dataDir, 'host-link.json'), linkRecordSchema)
  const isCurrentLink = link?.desired === 'linked' && link.hostId === registration.hostId
  return { registration: { ...registration, organizationId }, tunnel: isCurrentLink ? link.tunnel : null }
}

/**
 * The `--address` of `solus setup` and `solus connect`: the origin at which members
 * reach a cloud machine. HTTPS only, except loopback for development. A path, a query,
 * or credentials are refused: the address names the machine and nothing else.
 */
export function parseMachineAddress(value: string): string {
  const example = 'Give the HTTPS address of this machine, for example `--address https://machine.example.com`.'
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`\`--address ${value}\` is not an address. ${example}`)
  }
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(`The machine address must use HTTPS. ${example}`)
  }
  if (url.username || url.password) throw new Error(`The machine address must not contain a user name or a password. ${example}`)
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`The machine address must not contain a path or a query. ${example}`)
  return url.origin
}
