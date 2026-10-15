import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { accountAgentProfileResponseSchema, type AgentProfileIntegrationEntry } from '@solus/contracts/agent-profile'
import { ACCOUNT_VAULT_PATH, type CredentialRef, type McpRef, type VaultDisconnectRequest, type VaultSaveKeyRequest } from '@solus/contracts/vault'
import type { RpcInvokeMethod } from '@solus/contracts/rpc'
import type { SolusAPI } from '@solus/contracts/host-api'
import { uplinkStatusSchema, type UplinkStatus } from '@solus/contracts/uplink'
import { clientCredential, privateJwkSchema, type PrivateJwk } from '@solus/server/host/host-credential'
import { startFakeServers, type FakeServers } from '../../../tests/unit/integrations/fake-servers'
import type { LabClient } from './client'
import { hostClient, localOwnerClient, registerHost, signIn, type HostAddress, type SignedIn } from './cloud-sign-in'
import type { CloudHost, CloudScenarioContext } from './cloud-mode'
import type { CloudPersona, LocalCloudStack } from './local-cloud'

/**
 * The common parts of the cloud scenarios: account API calls with a person's own
 * account token, the directory, a host the owner registered, and an MCP server in
 * the owner's account. Each part that changes the account undoes it at the
 * scenario's end (`ctx.defer`).
 */

/** A call to the account plane with the person's account access token, as a signed-in client makes it. */
export async function accountApi(stack: LocalCloudStack, signedIn: SignedIn, path: string, init: { method?: string; body?: object } = {}): Promise<Response> {
  const token = await signedIn.oauth.accessToken({ kind: 'account' })
  if (!token) throw new Error(`${signedIn.persona.name} got no account token`)
  const headers: { [name: string]: string } = { authorization: `Bearer ${token}`, accept: 'application/json', connection: 'close' }
  if (init.body) headers['content-type'] = 'application/json'
  return fetch(`${stack.origin}${path}`, { method: init.method ?? (init.body ? 'POST' : 'GET'), headers, body: init.body ? JSON.stringify(init.body) : undefined, redirect: 'manual' })
}

const directorySchema = z.object({
  hosts: z.array(z.object({
    hostId: z.string(),
    installationId: z.string(),
    kind: z.string(),
    routes: z.array(z.object({ kind: z.string(), url: z.string() })),
    organizationIds: z.array(z.string()),
    managedState: z.string().optional(),
  })),
})
export type DirectoryEntry = z.infer<typeof directorySchema>['hosts'][number]

/** The person's host directory (`GET /v1/hosts`). */
export async function directory(stack: LocalCloudStack, signedIn: SignedIn): Promise<DirectoryEntry[]> {
  const response = await accountApi(stack, signedIn, '/v1/hosts')
  if (!response.ok) throw new Error(`The directory answered ${response.status}`)
  return directorySchema.parse(await response.json()).hosts
}

/** The website's "Remove host": ends the registration (`DELETE /v1/hosts/:id`). The status. */
export async function removeHost(stack: LocalCloudStack, signedIn: SignedIn, hostId: string): Promise<number> {
  return (await accountApi(stack, signedIn, `/v1/hosts/${hostId}`, { method: 'DELETE' })).status
}

type RpcArgs<M extends RpcInvokeMethod> = Parameters<SolusAPI[M]>
type RpcResult<M extends RpcInvokeMethod> = Awaited<ReturnType<SolusAPI[M]>>

/** One call as the host's trusted local owner, on a connection made for it. */
export async function localRpc<M extends RpcInvokeMethod>(host: HostAddress, persona: CloudPersona, method: M, ...args: RpcArgs<M>): Promise<RpcResult<M>> {
  const client = localOwnerClient(host, persona)
  const dialed = await client.connect()
  if (!dialed.ok) throw new Error(`The local owner could not connect: ${JSON.stringify(dialed)}`)
  try {
    return await client.rpc(method, ...args)
  } finally {
    client.close()
  }
}

export async function uplinkStatus(host: HostAddress, persona: CloudPersona): Promise<UplinkStatus> {
  return uplinkStatusSchema.parse(await localRpc(host, persona, 'uplinkStatus'))
}

/** The key the host keeps in its secret store (`host-credential`), or null when it has none. */
export function hostKeyOf(host: CloudHost): { clientId: string; privateJwk: PrivateJwk } | null {
  const file = join(host.dataDir, 'secrets', 'host-credential.json')
  if (!existsSync(file)) return null
  const parsed = z.object({ clientId: z.string(), privateJwk: privateJwkSchema }).safeParse(JSON.parse(readFileSync(file, 'utf8')))
  return parsed.success ? parsed.data : null
}

/** A client credentials request signed with a given key, as the host makes it (`private_key_jwt`). Status and body. */
export async function controlTokenWith(stack: LocalCloudStack, key: { clientId: string; privateJwk: PrivateJwk }): Promise<{ status: number; error: string | null }> {
  const tokenEndpoint = `${stack.origin}/api/auth/oauth2/token`
  const credential = clientCredential({ clientId: key.clientId, privateJwk: key.privateJwk, tokenEndpoint })
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', connection: 'close' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource: 'urn:solus:control',
      scope: 'host:link',
      client_id: key.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await credential.assertion(tokenEndpoint),
    }),
  })
  const body = z.object({ error: z.string().optional() }).safeParse(await response.json().catch(() => null))
  return { status: response.status, error: body.success ? body.data.error ?? null : null }
}

/**
 * Clean-up work as the person: with this sign-in while it lasts, else with a new one
 * that ends after the work (a scenario may have signed the client out).
 */
async function asSignedIn(ctx: CloudScenarioContext, signedIn: SignedIn, work: (current: SignedIn) => Promise<void>): Promise<void> {
  if (await signedIn.oauth.accessToken({ kind: 'account' })) return work(signedIn)
  const fresh = await signIn(ctx.stack, signedIn.persona)
  try {
    await work(fresh)
  } finally {
    await fresh.oauth.signOut()
  }
}

export interface OwnedHost {
  alice: SignedIn
  host: CloudHost
  hostId: string
  /** alice on the host's ticket door with her host token: its remote owner. */
  owner: LabClient
}

/**
 * alice signs in, a new host boots, she registers it (no link), and dials it with her
 * host token, so the host holds her personal delegation. At the end the owner removes
 * the host from her account.
 */
export async function ownedRegisteredHost(ctx: CloudScenarioContext): Promise<OwnedHost> {
  const alice = await ctx.signIn('alice')
  const host = await ctx.bootHost()
  const status = await registerHost(ctx.stack, host, alice)
  if (!status.registration.registered) throw new Error('The host did not register')
  const hostId = status.registration.registration.hostId
  ctx.defer('alice removes the host from her account', () => asSignedIn(ctx, alice, async (signedIn) => {
    const removed = await removeHost(ctx.stack, signedIn, hostId)
    if (removed !== 204 && removed !== 404) throw new Error(`Remove host answered ${removed}`)
  }))
  const owner = hostClient(host, alice, hostId, { asOwner: true })
  ctx.defer('alice closes her socket', async () => owner.close())
  const dialed = await owner.connect()
  if (!dialed.ok) throw new Error(`alice could not dial the host: ${JSON.stringify(dialed)}`)
  const held = await ctx.until(() => host.log().some((entry) => entry.msg === 'delegation_held' && entry.userId === alice.persona.userId && entry.scope === 'personal'), (yes) => yes)
  if (!held) throw new Error('The host made no personal delegation for alice')
  return { alice, host, hostId, owner }
}

export interface AccountMcp {
  fake: FakeServers
  /** The key the fake server accepts as `Bearer <key>`. */
  key: string
  slug: string
  url: string
  /** The server's entry, as alice's agent profile holds it. */
  entry: AgentProfileIntegrationEntry
}

/**
 * A local MCP server that needs a bearer key, put in alice's agent profile through the
 * account's own route (`PATCH /v1/account/agent-profile`). The server is in her
 * profile, so the cloud takes its loopback address (`mcpServerOf` reads the profile
 * first). No key is in her vault yet. Removed from the profile at the end.
 */
export async function profileMcpServer(ctx: CloudScenarioContext, alice: SignedIn): Promise<AccountMcp> {
  const fake = await startFakeServers()
  ctx.defer('the fake MCP server stops', () => fake.close())
  const key = `lab-key-${randomBytes(12).toString('hex')}`
  fake.accepted.add(`Bearer ${key}`)
  const slug = `lab-mcp-${randomBytes(3).toString('hex')}`
  const profileKey = `integration:${slug}`
  const entry: AgentProfileIntegrationEntry = { kind: 'integration', slug, name: `Lab MCP ${slug}`, url: fake.mcpUrl, auth: { kind: 'bearer', scheme: 'bearer' } }
  const readProfile = async (as: SignedIn = alice) => {
    const response = await accountApi(ctx.stack, as, '/v1/account/agent-profile')
    const body: unknown = await response.json().catch(() => null)
    const parsed = accountAgentProfileResponseSchema.safeParse(body)
    if (!parsed.success) throw new Error(`Reading the profile answered ${response.status}: ${JSON.stringify(body)}`)
    return parsed.data
  }
  const before = await readProfile()
  const patched = await accountApi(ctx.stack, alice, '/v1/account/agent-profile', { method: 'PATCH', body: { generation: before.generation, expectedRevision: before.revision, set: { [profileKey]: entry }, reset: [] } })
  if (!patched.ok) throw new Error(`Adding the server to the profile answered ${patched.status}: ${await patched.text()}`)
  ctx.defer('the server leaves alice\'s profile', () => asSignedIn(ctx, alice, async (as) => {
    const current = await readProfile(as)
    const reset = await accountApi(ctx.stack, as, '/v1/account/agent-profile', { method: 'PATCH', body: { generation: current.generation, expectedRevision: current.revision, set: {}, reset: [profileKey] } })
    if (!reset.ok) throw new Error(`Removing the server from the profile answered ${reset.status}`)
  }))
  return { fake, key, slug, url: fake.mcpUrl, entry }
}

/** A credential ref leaves alice's vault at the end; one already gone is fine. */
export function deferVaultRemoval(ctx: CloudScenarioContext, alice: SignedIn, label: string, ref: CredentialRef): void {
  ctx.defer(label, () => asSignedIn(ctx, alice, async (as) => {
    const disconnect: VaultDisconnectRequest = { ref }
    const removed = await accountApi(ctx.stack, as, ACCOUNT_VAULT_PATH, { method: 'DELETE', body: disconnect })
    if (removed.status !== 204 && removed.status !== 404) throw new Error(`Removing the connection answered ${removed.status}`)
  }))
}

/**
 * `profileMcpServer`, and its key in alice's account vault through the account's own
 * route (`PUT /v1/account/vault`, docs/plans/cloud-vault.md §2.3), as the website saves
 * a pasted key. Removed from the vault at the end.
 */
export async function accountMcpServer(ctx: CloudScenarioContext, alice: SignedIn): Promise<AccountMcp> {
  const mcp = await profileMcpServer(ctx, alice)
  const ref: McpRef = { kind: 'mcp', serverUrl: mcp.url }
  const saveKey: VaultSaveKeyRequest = { ref, key: mcp.key }
  const connected = await accountApi(ctx.stack, alice, ACCOUNT_VAULT_PATH, { method: 'PUT', body: saveKey })
  if (!connected.ok) throw new Error(`Connecting the key answered ${connected.status}: ${await connected.text()}`)
  deferVaultRemoval(ctx, alice, 'alice\'s connection leaves her vault', ref)
  return mcp
}

/** What the host shows of the account's MCP server after a pull: its record, its connection, and its tools. */
export interface HostIntegrationView {
  integrationId: string | null
  connection: { status: string; source: string } | null
  tools: string[]
}

/** The owner pulls her profile on the host, then reads the integration, its connection, and its tools. */
export async function pullAndRead(ctx: CloudScenarioContext, owner: LabClient, mcp: AccountMcp): Promise<HostIntegrationView> {
  // The host learns its owner from the cloud after registration; a pull before that is refused.
  await ctx.until(() => owner.rpc('agentProfilePull').then(() => true, () => false), (pulled) => pulled, 20_000)
  const integrations = await owner.rpc('integrationList')
  const integration = integrations.find((row) => row.slug === mcp.slug && row.url === mcp.url)
  if (!integration) return { integrationId: null, connection: null, tools: [] }
  // Tools first: listing them reads the credential, which also brings a `cloud` row back to connected.
  const tools = await owner.rpc('integrationTools', { id: integration.id }).catch(() => [])
  const connections = await owner.rpc('integrationConnectionList')
  const connection = connections.find((row) => row.integrationId === integration.id) ?? null
  return {
    integrationId: integration.id,
    connection: connection ? { status: connection.status, source: connection.source } : null,
    tools: tools.map((tool) => tool.name),
  }
}
