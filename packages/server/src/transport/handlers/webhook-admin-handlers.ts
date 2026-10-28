import { webhookAdminRefSchema, type WebhookAdminPort } from '@solus/contracts/webhook-admin'
import type { Principal } from '../../admission/principal'
import type { SolusServer } from '../server'

/**
 * The organization admin view of webhooks on the Solus API (docs/plans/webhooks.md
 * §2.7). Solus Cloud keeps the data and decides who is an organization admin; these
 * handlers name the person behind the call and pass the request to its port.
 */
export function registerWebhookAdminHandlers(server: SolusServer, port: WebhookAdminPort): void {
  /** The account behind the call; only a member's connection names one. */
  const userIdOf = (principal: Principal): string | null => principal.kind === 'org-member' ? principal.userId : null
  const refused = { ok: false, error: 'not_organization_admin' } as const

  server.register('webhookAdminList', async ([organizationId], ctx) => {
    const userId = userIdOf(ctx.principal)
    return userId ? port.list({ userId, organizationId }) : refused
  })

  server.register('webhookAdminPause', async ([ref], ctx) => {
    const userId = userIdOf(ctx.principal)
    return userId ? port.pause({ userId, ...webhookAdminRefSchema.parse(ref) }) : refused
  })

  server.register('webhookAdminResume', async ([ref], ctx) => {
    const userId = userIdOf(ctx.principal)
    return userId ? port.resume({ userId, ...webhookAdminRefSchema.parse(ref) }) : refused
  })
}
