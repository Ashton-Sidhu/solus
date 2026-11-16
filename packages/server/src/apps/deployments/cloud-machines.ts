import { z } from 'zod'
import { appSignInSchema, type AppAccessSubject, type AppSignIn } from '@solus/contracts/app-deployments'
import type { AppDeploymentSpec } from './app-platform'

/**
 * Solus Cloud for published apps (docs/plans/app-deploy.md §8.3, §7.3), as
 * the Solus of an app asks it. Two things are there: the machine that runs a
 * copy on Cloudflare, and the sign-in of a copy whose owner named people.
 * Each request is the owner's own, with the token this host holds for them.
 */

const TIMEOUT_MS = 120_000

/** The machines of the copies on Cloudflare, as one source gives them. */
export interface CloudMachines {
  /** What is missing to run a machine; null when nothing is. */
  problem(): string | null
  run(appId: string, slug: string, env: AppDeploymentSpec['env']): Promise<{ address: string }>
  exists(appId: string): Promise<boolean>
  sleep(appId: string): Promise<void>
  remove(appId: string): Promise<void>
}

/** One request to Solus Cloud as the owner of this host. A refusal says why no request went. */
export type CloudRequest = (path: string, init: { method: 'GET' | 'PUT' | 'POST' | 'DELETE'; body?: string }) => Promise<Response | { refused: string; message: string }>

/** What a request for a machine or for the access of a copy carries. */
type CloudBody = { slug: string; env: AppDeploymentSpec['env'] } | { env: AppDeploymentSpec['env'] } | { slug: string; address: string; subjects: readonly AppAccessSubject[] }

const machineSchema = z.object({ address: z.string().url() })
const machineStateSchema = z.object({ exists: z.boolean() })
const problemSchema = z.object({ error: z.object({ message: z.string() }) })

async function answerOf(response: Response | { refused: string; message: string } | null): Promise<z.infer<ReturnType<typeof z.json>>> {
  if (!response) throw new Error('Solus Cloud did not answer.')
  if ('refused' in response) throw new Error(response.message)
  const body = z.json().safeParse(await response.json().catch(() => null))
  if (!response.ok) throw new Error(problemSchema.safeParse(body.data).data?.error.message ?? `Solus Cloud refused the request for this app (${response.status}).`)
  return body.data ?? null
}

export interface SolusCloudAppsOptions {
  request: CloudRequest
  /** The owner is signed in to Solus on this host, so a request can go. */
  isSignedIn: () => boolean
}

/** The cloud API for the apps of the owner: `/v1/apps/<app id>/machine` and `/v1/apps/<app id>/access`. */
export class SolusCloudApps implements CloudMachines {
  constructor(private readonly options: SolusCloudAppsOptions) {}

  private ask(method: 'GET' | 'PUT' | 'POST' | 'DELETE', appId: string, part: string, body?: CloudBody): Promise<z.infer<ReturnType<typeof z.json>>> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(appId)) throw new Error('This app has no name that Solus Cloud takes.')
    return this.options.request(`/v1/apps/${appId}/${part}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then(answerOf)
  }

  /** The owner is signed in to Solus on this host. */
  isSignedIn(): boolean {
    return this.options.isSignedIn()
  }

  problem(): string | null {
    return this.isSignedIn() ? null : 'Sign in to Solus on the host of the app to publish to Solus Cloud.'
  }

  async run(appId: string, slug: string, env: AppDeploymentSpec['env']): Promise<{ address: string }> {
    return machineSchema.parse(await this.ask('PUT', appId, 'machine', { slug, env }))
  }

  async exists(appId: string): Promise<boolean> {
    return machineStateSchema.parse(await this.ask('GET', appId, 'machine')).exists
  }

  async sleep(appId: string): Promise<void> {
    await this.ask('POST', appId, 'machine/sleep')
  }

  async remove(appId: string): Promise<void> {
    await this.ask('DELETE', appId, 'machine')
  }

  /**
   * Tells Solus Cloud who opens a copy at its address (§7.3): the people,
   * the teams, and the organizations that the owner named. Solus Cloud signs
   * each visitor in and decides their role; the copy holds no list.
   */
  async setAccess(appId: string, access: { slug: string; address: string; subjects: readonly AppAccessSubject[] }): Promise<AppSignIn> {
    if (!this.isSignedIn()) throw new Error('Sign in to Solus on the host of the app to name the people who open it.')
    return appSignInSchema.parse(await this.ask('PUT', appId, 'access', access))
  }

  /** The copy no longer signs people in: Solus Cloud forgets its list. */
  async removeAccess(appId: string): Promise<void> {
    await this.ask('DELETE', appId, 'access')
  }
}

export interface WorkerMachinesOptions {
  /** The origin of the app Worker. */
  url: string
  /** The token of the Worker's management endpoint. */
  token: string
  /** The name of an app's machine: one DNS label. A Worker on workers.dev holds one app with a fixed name. */
  name?: (appId: string) => string
  fetch?: typeof fetch
}

/**
 * An app Worker that the host names itself (`solus-cloud/app-worker`, with
 * its management token): for a person who runs their own Worker, and for the
 * test of the Worker. No Solus Cloud account is in this path.
 */
export function workerMachines(options: WorkerMachinesOptions): CloudMachines {
  const machine = (appId: string): string => {
    const name = options.name?.(appId) ?? `app-${appId.toLowerCase()}`
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error('This app has no name that the app Worker takes.')
    return name
  }
  const ask = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', appId: string, operation = '', body?: CloudBody) =>
    (options.fetch ?? fetch)(`${options.url.replace(/\/$/, '')}/_cloud/v1/apps/${machine(appId)}${operation}`, {
      method,
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null)
  return {
    problem: () => null,
    run: async (appId, _slug, env) => machineSchema.parse(await answerOf(await ask('PUT', appId, '', { env }))),
    exists: async (appId) => machineStateSchema.parse(await answerOf(await ask('GET', appId))).exists,
    sleep: async (appId) => { await answerOf(await ask('POST', appId, '/sleep')) },
    remove: async (appId) => {
      const response = await ask('DELETE', appId)
      // A machine that the Worker does not have is removed already.
      if (response?.status !== 404) await answerOf(response)
    },
  }
}
