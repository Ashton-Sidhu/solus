import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { agentProfileKeyOf, type AgentProfileCopy } from '@solus/contracts/agent-profile'
import type { IpcContext, SessionCtx } from '@solus/contracts/types'
import {
  VAULT_CONNECT_PATH,
  VAULT_PATH,
  VAULT_SIGN_IN_CALLBACK_PATH,
  vaultConnectResultSchema,
  vaultConnectionListSchema,
  type CredentialRef,
  type VaultConnection,
} from '@solus/contracts/vault'
import type { LabClient } from '../../src/client'
import { cloudModeScenario, type CloudHost, type CloudScenarioContext } from '../../src/cloud-mode'
import { accountApi, deferVaultRemoval, localRpc, profileMcpServer, removeHost } from '../../src/cloud-fixtures'
import { hostClient, registerHost, type SignedIn } from '../../src/cloud-sign-in'
import { cookieOf, LAB_PROVIDER_CLIENT } from '../../src/local-cloud'

/**
 * Signed in means the account (docs/plans/cloud-vault.md §2.5). alice's laptop is not
 * linked: she keeps a TypeSafe key and the key of an MCP server of her profile on it.
 * When she signs in (registers the host to her account), the host moves both into her
 * account vault and keeps no copy of any login of hers. Her second host reads both
 * from the account. GitHub, connected on the website (the cloud's own sign-in, with the
 * cloud's provider fixture in place of GitHub), reaches her host's GitHub reads. When
 * the account removes the host, the host keeps nothing for her. A token that is not a
 * person's delegated token (the hosts token the host worker sends) reads no provider
 * and no TypeSafe ref.
 */

const GITHUB: CredentialRef = { kind: 'provider', provider: 'github' }
const TYPESAFE: CredentialRef = { kind: 'typesafe' }

/** The files in the host's secret store that hold a person's credential: provider logins, TypeSafe, MCP tokens. */
function personSecrets(host: CloudHost): string[] {
  const dir = join(host.dataDir, 'secrets')
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((name) => /^(github-oauth|google-oauth|atlassian-oauth|typesafe|integration-token-.+)\.json$/.test(name))
}

async function vaultOf(ctx: CloudScenarioContext, alice: SignedIn): Promise<VaultConnection[]> {
  const response = await accountApi(ctx.stack, alice, VAULT_PATH)
  return vaultConnectionListSchema.parse(await response.json()).connections
}

const holds = (connections: VaultConnection[], match: (ref: CredentialRef) => boolean) =>
  connections.some((connection) => match(connection.ref) && connection.status === 'connected')

/** The renderer's context for a provider call with no project: the host's GitHub provider. */
function noProject(): IpcContext {
  const session: Partial<SessionCtx> = { projectPath: '', workingDirectory: '' }
  // SAFETY: `providerStatus` reads only `session.projectPath` and `session.workingDirectory`.
  return { session } as IpcContext
}

/** alice registers the host to her account and dials it as its remote owner; the host holds her personal delegation. */
async function signInOn(ctx: CloudScenarioContext, alice: SignedIn, host: CloudHost): Promise<{ hostId: string; owner: LabClient }> {
  const status = await registerHost(ctx.stack, host, alice)
  if (!status.registration.registered) throw new Error('The host did not register')
  const hostId = status.registration.registration.hostId
  ctx.defer(`alice removes host ${hostId} from her account`, async () => {
    const removed = await removeHost(ctx.stack, alice, hostId)
    if (removed !== 204 && removed !== 404) throw new Error(`Remove host answered ${removed}`)
  })
  const owner = hostClient(host, alice, hostId, { asOwner: true })
  ctx.defer('alice closes her socket', async () => owner.close())
  const dialed = await owner.connect()
  if (!dialed.ok) throw new Error(`alice could not dial the host: ${JSON.stringify(dialed)}`)
  const held = await ctx.until(() => host.log().some((entry) => entry.msg === 'delegation_held' && entry.userId === alice.persona.userId && entry.scope === 'personal'), (yes) => yes, 20_000)
  if (!held) throw new Error('The host made no personal delegation for alice')
  return { hostId, owner }
}

export default cloudModeScenario('vault: signed in means the account', async (ctx) => {
  const alice = await ctx.signIn('alice')
  const typesafeKey = `ts-lab-${Date.now().toString(36)}`

  ctx.step('alice\'s MCP server is in her profile; no key for it is in her vault')
  const mcp = await profileMcpServer(ctx, alice)
  const mcpRef: CredentialRef = { kind: 'mcp', serverUrl: mcp.url }
  deferVaultRemoval(ctx, alice, 'the MCP key leaves alice\'s vault', mcpRef)
  deferVaultRemoval(ctx, alice, 'the TypeSafe key leaves alice\'s vault', TYPESAFE)
  ctx.check('her vault holds no key for the server and no TypeSafe key before the link', !holds(await vaultOf(ctx, alice), (ref) => (ref.kind === 'mcp' && ref.serverUrl === mcp.url) || ref.kind === 'typesafe'))

  ctx.step('host A is not linked: its local owner keeps a TypeSafe key and the server\'s key on it')
  const hostA = await ctx.bootHost()
  const persona = ctx.stack.personas.alice
  const copy: AgentProfileCopy = { profile: { [agentProfileKeyOf(mcp.entry)]: mcp.entry }, skipped: [] }
  await localRpc(hostA, persona, 'agentProfileApply', copy)
  const record = (await localRpc(hostA, persona, 'integrationList')).find((row) => row.url === mcp.url)
  if (!record) throw new Error('The pushed profile made no integration on host A')
  await localRpc(hostA, persona, 'integrationConnectSubmit', { id: record.id, value: mcp.key })
  await localRpc(hostA, persona, 'typeSafeKeySet', typesafeKey)
  ctx.check('host A keeps the TypeSafe key itself', (await localRpc(hostA, persona, 'typeSafeKeyStatus')).location === 'host')
  const before = personSecrets(hostA)
  ctx.check('host A\'s store holds the TypeSafe key and the MCP key', before.includes('typesafe.json') && before.some((name) => name.startsWith('integration-token-')), JSON.stringify(before))

  ctx.step('alice signs in on host A: the host is linked to her account')
  const { hostId: hostIdA, owner: ownerA } = await signInOn(ctx, alice, hostA)
  const linked = await ctx.until(() => hostA.log().some((entry) => entry.msg === 'host_user_linked'), (yes) => yes, 20_000)
  ctx.check('host A\'s user is now her account', linked)
  // (a) What could be uploaded is in her account now.
  const uploaded = await ctx.until(() => vaultOf(ctx, alice), (connections) => holds(connections, (ref) => ref.kind === 'typesafe') && holds(connections, (ref) => ref.kind === 'mcp' && ref.serverUrl === mcp.url), 30_000)
  ctx.check('her vault holds the TypeSafe key from host A', holds(uploaded, (ref) => ref.kind === 'typesafe'), JSON.stringify(uploaded.map((each) => each.ref)))
  ctx.check('her vault holds the MCP key from host A', holds(uploaded, (ref) => ref.kind === 'mcp' && ref.serverUrl === mcp.url))
  ctx.check('the cloud proved the uploaded MCP key with the server', mcp.fake.mcpAuthorizations.includes(`Bearer ${mcp.key}`))
  // (b) The host keeps no copy.
  const after = await ctx.until(async () => personSecrets(hostA), (names) => names.length === 0, 10_000)
  ctx.check('host A keeps no copy of any of her logins (provider, TypeSafe, MCP)', after.length === 0, JSON.stringify(after))
  const statusA = await ownerA.rpc('typeSafeKeyStatus')
  ctx.check('host A reads her TypeSafe key from the account', statusA.location === 'account' && statusA.source === 'saved', JSON.stringify(statusA))
  const rowA = (await ownerA.rpc('integrationConnectionList')).find((row) => row.integrationId === record.id)
  ctx.check('host A\'s connection row reads from the account', rowA?.source === 'cloud' && rowA.status === 'connected', JSON.stringify(rowA))

  ctx.step('host B reads both from her account')
  const seen = mcp.fake.mcpAuthorizations.length
  const hostB = await ctx.bootHost()
  const { owner: ownerB } = await signInOn(ctx, alice, hostB)
  const statusB = await ctx.until(() => ownerB.rpc('typeSafeKeyStatus'), (status) => status.location === 'account' && status.source === 'saved', 20_000)
  ctx.check('host B reads her TypeSafe key from the account', statusB.location === 'account' && statusB.source === 'saved', JSON.stringify(statusB))
  await ctx.until(() => ownerB.rpc('agentProfilePull').then(() => true, () => false), (pulled) => pulled, 20_000)
  const recordB = (await ownerB.rpc('integrationList')).find((row) => row.url === mcp.url)
  ctx.check('host B has the server from her profile', recordB !== undefined)
  const toolsB = recordB ? await ownerB.rpc('integrationTools', { id: recordB.id }).catch(() => []) : []
  ctx.check('host B lists the server\'s tools', toolsB.some((tool) => tool.name.includes('echo')), JSON.stringify(toolsB.map((tool) => tool.name)))
  const sinceB = mcp.fake.mcpAuthorizations.slice(seen)
  ctx.check('host B called the server with the key from her account', sinceB.length > 0 && sinceB.every((header) => header === `Bearer ${mcp.key}`), `${sinceB.length} calls`)
  ctx.check('host B holds no copy of it', personSecrets(hostB).length === 0, JSON.stringify(personSecrets(hostB)))

  ctx.step('alice connects GitHub on the website; it reaches her host')
  deferVaultRemoval(ctx, alice, 'GitHub leaves alice\'s vault', GITHUB)
  const started = await accountApi(ctx.stack, alice, VAULT_CONNECT_PATH, { method: 'POST', body: { ref: GITHUB } })
  const start = vaultConnectResultSchema.parse(await started.json())
  if (start.kind !== 'browser') throw new Error(`GitHub's sign-in did not start in a browser: ${JSON.stringify(start)}`)
  const opened = await fetch(new URL(start.url, ctx.stack.origin), { headers: { cookie: alice.websiteCookie }, redirect: 'manual' })
  const authorize = new URL(opened.headers.get('location') ?? '', ctx.stack.origin)
  ctx.check('the start page sends the browser to GitHub\'s authorize page', authorize.origin === 'https://github.com', authorize.origin)
  const callback = new URL(VAULT_SIGN_IN_CALLBACK_PATH, ctx.stack.origin)
  callback.searchParams.set('code', LAB_PROVIDER_CLIENT.code)
  callback.searchParams.set('state', authorize.searchParams.get('state') ?? '')
  const finished = await fetch(callback, { headers: { cookie: `${alice.websiteCookie}; ${cookieOf(opened)}` }, redirect: 'manual' })
  ctx.check('the callback finishes the sign-in', finished.status < 400, String(finished.status))
  ctx.check('her vault holds GitHub', holds(await vaultOf(ctx, alice), (ref) => ref.kind === 'provider' && ref.provider === 'github'))
  const github = await ownerA.rpc('providerStatus', noProject())
  ctx.check('her host reads GitHub from the account', github.connected && github.login === LAB_PROVIDER_CLIENT.githubLogin, JSON.stringify(github))
  ctx.check('host A still keeps no copy', personSecrets(hostA).length === 0, JSON.stringify(personSecrets(hostA)))

  ctx.step('a token that is not her delegated token reads no provider and no TypeSafe ref')
  for (const ref of [GITHUB, TYPESAFE]) {
    const response = await fetch(new URL(VAULT_PATH, ctx.stack.origin), {
      method: 'POST',
      headers: { authorization: 'Bearer lab-hosts-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ref }),
    })
    ctx.check(`the executor route refuses the hosts token for ${ref.kind}`, response.status === 401, String(response.status))
  }

  ctx.step('the account removes host A; after its restart it keeps nothing for alice')
  ownerA.close()
  const removed = await removeHost(ctx.stack, alice, hostIdA)
  ctx.check('Remove host answers 204', removed === 204, String(removed))
  const restarted = await ctx.restartHost(hostA)
  const unlinked = await ctx.until(() => restarted.log().some((entry) => entry.msg === 'host_user_unlinked'), (yes) => yes, 30_000)
  ctx.check('host A\'s user is local again', unlinked)
  ctx.check('host A keeps no credential of hers', personSecrets(restarted).length === 0, JSON.stringify(personSecrets(restarted)))
  const local = await localRpc(restarted, persona, 'typeSafeKeyStatus')
  ctx.check('the local owner has no TypeSafe key on host A', local.location === 'host' && local.source === null, JSON.stringify(local))
  const rows = await localRpc(restarted, persona, 'integrationConnectionList')
  ctx.check('the local owner has no MCP connection on host A', rows.length === 0, JSON.stringify(rows))
  const githubAfter = await localRpc(restarted, persona, 'providerStatus', noProject())
  ctx.check('the local owner has no GitHub login on host A', !githubAfter.connected, JSON.stringify(githubAfter))
})
