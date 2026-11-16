import { z } from 'zod'
import {
  APP_MANAGEMENT_PATHS,
  APP_MANAGEMENT_SIGNATURE_HEADER,
  appDeploymentStatusSchema,
  appServiceAnswerSchema,
  appVersionPushReceiptSchema,
  type AppDeploymentStatus,
  type AppManagementOperation,
  type AppVersionPush,
  type AppVersionPushReceipt,
} from '@solus/contracts/app-deployments'
import { signManagementRequest } from '../runtime/management-signature'
import type { ManagementFetch } from './app-platform'

/**
 * The management API of one deployment, as its Solus calls it
 * (docs/plans/app-deploy.md §5.3): a version to run, and how the deployment
 * is. Each request is signed with the app key.
 */

/** A version that starts applies its migrations. */
const PUSH_TIMEOUT_MS = 3 * 60_000
const STATUS_TIMEOUT_MS = 10_000
const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 250

const problemSchema = z.object({ error: z.string() })

export class DeploymentClient {
  constructor(private readonly origin: string, private readonly appKey: string, private readonly fetchImpl: ManagementFetch = fetch) {}

  private async ask(method: 'GET' | 'POST', path: string, body: AppVersionPush | AppManagementOperation | null, timeoutMs: number): Promise<z.infer<ReturnType<typeof z.json>>> {
    const text = body === null ? '' : JSON.stringify(body)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        method,
        headers: { [APP_MANAGEMENT_SIGNATURE_HEADER]: signManagementRequest(this.appKey, { method, path, body: text }), 'content-type': 'application/json' },
        body: body === null ? undefined : text,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new Error('The deployment of this app did not answer. Check that its container runs.')
    }
    const answer = z.json().parse(await response.json().catch(() => null))
    if (response.status !== 200) throw new Error(problemSchema.safeParse(answer).data?.error ?? `The deployment answered ${response.status}.`)
    return answer
  }

  async pushVersion(push: AppVersionPush): Promise<AppVersionPushReceipt> {
    return appVersionPushReceiptSchema.parse(await this.ask('POST', APP_MANAGEMENT_PATHS.versions, push, PUSH_TIMEOUT_MS))
  }

  /** Runs one operation of the app in the deployment. The app's own failure is thrown with its reason. */
  async callOperation(request: AppManagementOperation): Promise<z.infer<ReturnType<typeof z.json>>> {
    const answer = appServiceAnswerSchema.parse(await this.ask('POST', APP_MANAGEMENT_PATHS.operations, request, PUSH_TIMEOUT_MS))
    if (!answer.ok) throw new Error(answer.error)
    return answer.value
  }

  async status(): Promise<AppDeploymentStatus> {
    return appDeploymentStatusSchema.parse(await this.ask('GET', APP_MANAGEMENT_PATHS.status, null, STATUS_TIMEOUT_MS))
  }

  /** Waits until the runtime of a new container answers. */
  async ready(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      const ok = await this.fetchImpl(`${this.origin}${APP_MANAGEMENT_PATHS.health}`, { signal: AbortSignal.timeout(5000) }).then((response) => response.ok, () => false)
      if (ok) return
      if (Date.now() > deadline) throw new Error('The container of this app started, and its runtime did not answer in a minute.')
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
  }
}
