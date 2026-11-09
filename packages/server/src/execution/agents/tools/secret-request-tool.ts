import { z } from 'zod'
import { secretPageUrl } from '@solus/contracts/secret-request'
import { requestSecrets } from '../../sessions/secret-requests'
import type { AgentTool } from './agent-tool'

/**
 * `request_secret`, a session tool for Claude and Codex (docs/plans/webhooks.md §3.6).
 * It is on every prompted run, whatever this host offers: any tool with a `secretRef`
 * field takes the ref it gives, and a shell command reads the file a `file` secret
 * gives. The mechanism is `sessions/secret-requests.ts`.
 */

const requestSecretFields = {
  secrets: z.array(z.object({
    name: z.string().describe('What it is, for example "GitHub webhook secret".'),
    reason: z.string().describe('Why it is needed and where to find it.'),
    delivery: z.enum(['ref', 'file']).optional().describe('ref (default): a secretRef for a tool. file: a private file path for your own shell commands, such as a CLI token.'),
    url: z.string().refine((url) => secretPageUrl(url) !== null, 'url must be an http or https link.').optional().describe('A sign-in or setup page the card opens. http(s) only.'),
  })).min(1).max(10).describe('Every secret the task needs, on one card.'),
}

const REQUEST_SECRET_DESC = 'Ask the person for secrets (API keys, passwords) on one private card. No value reaches the transcript or you. Each saved one gives a secretRef that a tool\'s `secretRef` field takes in place of the secret: one use, this session, 15 minutes. For a secret that your own shell commands need (a CLI or API token), set `delivery: "file"`: you get the path of a private file that holds it for 24 hours. Read it inside the command, for example `TOKEN="$(cat \'<path>\')" cli ...`; never print it, echo it, or copy it elsewhere. Use it whenever a tool or command needs a credential; never ask the person to type a secret into the conversation. Result: `secrets` in order, each `saved` with its `secretRef` or `path`, or `declined`; or `cancelled`. Asked how to provide a secret: call this now, do not explain instead.'

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
