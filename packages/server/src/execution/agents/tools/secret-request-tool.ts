import { z } from 'zod'
import { requestSecrets } from '../../sessions/secret-requests'
import type { AgentTool } from './agent-tool'

/**
 * `request_secret`, a session tool for Claude and Codex (docs/plans/webhooks.md §3.6).
 * It is on every prompted run, whatever this host offers: any tool with a `secretRef`
 * field takes the ref it gives. The mechanism is `sessions/secret-requests.ts`.
 */

const requestSecretFields = {
  secrets: z.array(z.object({
    name: z.string().describe('What it is, for example "GitHub webhook secret".'),
    reason: z.string().describe('Why it is needed and where to find it.'),
  })).min(1).max(10).describe('Every secret the task needs, on one card.'),
}

const REQUEST_SECRET_DESC = 'Ask the person for secrets (API keys, passwords) on one private card. No value reaches the transcript or you. Each saved one gives a secretRef that a tool\'s `secretRef` field takes in place of the secret: one use, this session, 15 minutes. Use it whenever a tool needs a credential; never ask the person to type a secret into the conversation. Result: `secrets` in order, each `saved` with its `secretRef` or `declined`; or `cancelled`. Asked how to provide a secret: call this now, do not explain instead.'

export const requestSecretAgentTool: AgentTool<typeof requestSecretFields> = {
  name: 'request_secret',
  description: REQUEST_SECRET_DESC,
  inputFields: requestSecretFields,
  // The person answers the card; there is nothing more to approve.
  requiresApproval: false,
  async execute(input, context) {
    try {
      // The outcome is the answer, not an error: a decline is the person's choice.
      return { ok: true, text: JSON.stringify(await requestSecrets(context, input.secrets)) }
    } catch (err) {
      return { ok: false, text: `request_secret: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
