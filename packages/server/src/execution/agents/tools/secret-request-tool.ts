import { z } from 'zod'
import { requestSecret } from '../../sessions/secret-requests'
import type { AgentTool } from './agent-tool'

/**
 * `request_secret`, a session tool for Claude and Codex (docs/plans/webhooks.md §3.6).
 * It is on every prompted run, whatever this host offers: any tool with a `secretRef`
 * field takes the ref it gives. The mechanism is `sessions/secret-requests.ts`.
 */

const requestSecretFields = {
  name: z.string().describe('What the secret is, for the person, for example "GitHub webhook secret for acme/api".'),
  reason: z.string().describe('Why it is needed and where the person finds it.'),
}

const REQUEST_SECRET_DESC = 'Ask the person for a secret (an API key, a signing secret, a password) through a private card in this session. The value never appears in the transcript or to you. You get a one-use secretRef that tools with a `secretRef` field accept in place of the secret. It works once, only in this session, for 15 minutes. Use it whenever a tool needs a credential; never ask the person to type a secret into the conversation. The result is `{ "status": "saved", "secretRef": "…" }`, or `{ "status": "declined" }` or `{ "status": "cancelled" }`: then ask again only if the secret is still needed. Asked how to provide a secret: call this now, do not explain instead.'

export const requestSecretAgentTool: AgentTool<typeof requestSecretFields> = {
  name: 'request_secret',
  description: REQUEST_SECRET_DESC,
  inputFields: requestSecretFields,
  // The person answers the card; there is nothing more to approve.
  requiresApproval: false,
  async execute(input, context) {
    try {
      // The outcome is the answer, not an error: a decline is the person's choice.
      return { ok: true, text: JSON.stringify(await requestSecret(context, { name: input.name, reason: input.reason })) }
    } catch (err) {
      return { ok: false, text: `request_secret: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
