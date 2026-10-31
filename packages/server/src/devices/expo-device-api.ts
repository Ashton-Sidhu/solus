// Adapted from T3 Code's ExpoApi.ts and ExpoApi.graphql (MIT, pingdotgg/t3code).
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const sessionSchema = z.object({
  id: z.string(), status: z.string(),
  remoteConfig: z.object({
    agentDeviceRemoteSessionUrl: z.string().url(), agentDeviceRemoteSessionToken: z.string(),
    previewApiUrl: z.string().url().nullable(), webPreviewToken: z.string().nullable(),
  }).nullable(),
})
export type ExpoDeviceSession = z.infer<typeof sessionSchema>
const sessionFields = 'id status remoteConfig { ... on AgentDeviceRunSessionRemoteConfig { agentDeviceRemoteSessionUrl agentDeviceRemoteSessionToken previewApiUrl webPreviewToken } }'

export async function expoCredential(saved: string, env: NodeJS.ProcessEnv = process.env): Promise<{ name: string; value: string }> {
  const token = saved.trim() || env.EXPO_TOKEN?.trim()
  if (token) {
    if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('The Expo access token is invalid.')
    return { name: 'authorization', value: `Bearer ${token}` }
  }
  const state = await readFile(join(homedir(), '.expo', 'state.json'), 'utf8').then((raw) => {
    try { return z.object({ auth: z.object({ sessionSecret: z.string() }).nullable() }).safeParse(JSON.parse(raw)) }
    catch { return null }
  }).catch(() => null)
  const secret = state?.success ? state.data.auth?.sessionSecret : null
  if (!secret || !/^[\x21-\x7e]+$/.test(secret)) throw new Error('Set EXPO_TOKEN on this host or run eas login.')
  return { name: 'expo-session', value: secret }
}

export class ExpoDeviceApiError extends Error {
  constructor(message: string, readonly rejected = false) { super(message) }
}

export class ExpoDeviceApi {
  constructor(private readonly savedToken: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(query: string, variables: { appId?: string; id?: string; input?: { appId: string; name: string; platform: string; type: string; maxRunTimeMinutes: number; maxIdleTimeMinutes: number; corsOrigins: string[] } }, schema: z.ZodType<T>): Promise<T> {
    const credential = await expoCredential(this.savedToken)
    let response: Response
    try {
      response = await this.fetchImpl('https://api.expo.dev/graphql', {
        method: 'POST', headers: { 'content-type': 'application/json', [credential.name]: credential.value },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000),
      })
    } catch { throw new Error('Expo did not answer. Check the connection and try again.') }
    // Never attach transport/decode errors: they can contain credentials and session tokens.
    if (!response.ok) throw new ExpoDeviceApiError(`Expo answered HTTP ${response.status}. Check the account and access token.`, response.status < 500)
    const reply = z.object({ data: schema.nullable().optional(), errors: z.array(z.object({ message: z.string(), extensions: z.object({ errorType: z.string().optional(), isTransient: z.boolean().optional(), errorCode: z.string().optional() }).optional() })).optional() }).safeParse(await response.json().catch(() => null))
    if (!reply.success) throw new ExpoDeviceApiError('Expo returned an unexpected reply.')
    if (reply.data.errors?.length || !reply.data.data) {
      const rejected = reply.data.data === null && !!reply.data.errors?.length && reply.data.errors.every((error) => error.extensions?.errorType === 'USER' && !error.extensions.isTransient && error.extensions.errorCode !== 'INTERNAL_SERVER_ERROR')
      throw new ExpoDeviceApiError('Expo refused the request. Check EAS Simulator access for this project.', rejected)
    }
    return reply.data.data
  }

  async check(appId: string) {
    const result = await this.call('query SolusExpoViewer { meActor { accounts { appsPaginated(first: 100) { edges { node { id fullName } } } } } }', {}, z.object({ meActor: z.object({ accounts: z.array(z.object({ appsPaginated: z.object({ edges: z.array(z.object({ node: z.object({ id: z.string(), fullName: z.string() }) })) }) })) }) }))
    const apps = result.meActor.accounts.flatMap((account) => account.appsPaginated.edges.map((edge) => edge.node))
    if (!appId) return apps
    const gate = await this.call('query SolusEasAvailability($appId: String!) { app { byId(appId: $appId) { ownerAccount { accountFeatureGates(filter: ["device-run-sessions"]) } } } }', { appId }, z.object({ app: z.object({ byId: z.object({ ownerAccount: z.object({ accountFeatureGates: z.object({ 'device-run-sessions': z.boolean().optional() }) }) }) }) }))
    if (!gate.app.byId.ownerAccount.accountFeatureGates['device-run-sessions']) throw new Error('EAS Simulator is not enabled for this Expo account.')
    return apps
  }

  async create(input: { appId: string; name: string; platform: 'ios' | 'android'; maxRunTimeMinutes: number; maxIdleTimeMinutes: number }): Promise<string> {
    const result = await this.call('mutation SolusEasCreate($input: CreateDeviceRunSessionInput!) { deviceRunSession { createDeviceRunSession(deviceRunSessionInput: $input) { id } } }', { input: { ...input, platform: input.platform.toUpperCase(), type: 'AGENT_DEVICE', corsOrigins: ['http://localhost'] } }, z.object({ deviceRunSession: z.object({ createDeviceRunSession: z.object({ id: z.string() }) }) }))
    return result.deviceRunSession.createDeviceRunSession.id
  }

  async session(id: string): Promise<ExpoDeviceSession> {
    return (await this.call(`query SolusEasSession($id: ID!) { deviceRunSessions { byId(deviceRunSessionId: $id) { ${sessionFields} } } }`, { id }, z.object({ deviceRunSessions: z.object({ byId: sessionSchema }) }))).deviceRunSessions.byId
  }

  async active(appId: string): Promise<{ id: string; name: string; status: string }[]> {
    const result = await this.call('query SolusEasActive($appId: String!) { app { byId(appId: $appId) { deviceRunSessionsPaginated(first: 50, filter: { statuses: [NEW, QUEUED, STARTING, IN_PROGRESS] }) { edges { node { id name status } } } } } }', { appId }, z.object({ app: z.object({ byId: z.object({ deviceRunSessionsPaginated: z.object({ edges: z.array(z.object({ node: z.object({ id: z.string(), name: z.string(), status: z.string() }) })) }) }) }) }))
    return result.app.byId.deviceRunSessionsPaginated.edges.map((edge) => edge.node)
  }

  async stop(id: string): Promise<string> {
    const result = await this.call('mutation SolusEasStop($id: ID!) { deviceRunSession { ensureDeviceRunSessionStopped(deviceRunSessionId: $id) { id status } } }', { id }, z.object({ deviceRunSession: z.object({ ensureDeviceRunSessionStopped: z.object({ id: z.string(), status: z.string() }) }) }))
    return result.deviceRunSession.ensureDeviceRunSessionStopped.status
  }
}
