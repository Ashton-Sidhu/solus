import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { hostRegistrationSchema, hostTunnelSchema, uplinkDesiredStateSchema, type HostRegistration, type HostTunnel } from '@solus/contracts/uplink'

/**
 * A cloud machine, as the command line sees it (plans/034-one-cloud-machine-kind.md).
 * A server becomes one when it registers with an organization code. After that it
 * trusts nobody by network position, so its local socket refuses this CLI. What the
 * CLI can still say comes from the two non-secret records the server keeps in its data
 * directory: `host-registration.json`
 * (`packages/server/src/host/host-registration.ts`) and `host-link.json`
 * (`packages/server/src/transport/uplink/link.ts`). The server writes them to
 * `SOLUS_DATA_DIR`, which is the data directory this CLI starts it with.
 */

/** How the internet reaches a linked host: at its own HTTPS address (`direct`), or through a Cloudflare tunnel. */
export type LinkReach = 'direct' | 'tunnel'

const registrationRecordSchema = z.object({ version: z.literal(1), registration: hostRegistrationSchema })
const linkRecordSchema = z.object({
  version: z.literal(2),
  hostId: z.string().min(1),
  desired: uplinkDesiredStateSchema,
  tunnel: hostTunnelSchema,
  /** Absent is a tunnel, as the server writes it. */
  reach: z.enum(['tunnel', 'direct']).optional(),
})

export interface CloudMachineRecord {
  registration: HostRegistration & { organizationId: string }
  /** Where the machine is reached, and the port that forwards to it. Null until Solus cloud made the link. */
  tunnel: HostTunnel | null
  reach: LinkReach
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
  return { registration: { ...registration, organizationId }, tunnel: isCurrentLink ? link.tunnel : null, reach: link?.reach ?? 'tunnel' }
}

/**
 * The reach of the link in `dataDir`. A personal server answers its live status
 * (`uplinkStatus`), which does not say which way its link goes; the link record does.
 */
export function readLinkReach(dataDir: string): LinkReach {
  return readRecord(join(dataDir, 'host-link.json'), linkRecordSchema)?.reach ?? 'tunnel'
}

/** How a linked host is reached, for a status line: its own address, or the host name of its tunnel. */
export function describeReach(tunnel: HostTunnel, reach: LinkReach, hasManagedCompute = false): string {
  if (reach === 'tunnel') return `Tunnel: ${tunnel.hostname}`
  // The provider of a machine with managed compute forwards its address by itself.
  return `Address: https://${tunnel.hostname}${hasManagedCompute ? '' : ` (it must forward to port ${tunnel.proxiedPort} on this machine)`}`
}

/**
 * The `--address` of `solus setup` and `solus connect`: the origin at which the
 * internet reaches this machine, in place of a tunnel. HTTPS only, except loopback for
 * development. A path, a query, or credentials are refused: the address names the
 * machine and nothing else.
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
