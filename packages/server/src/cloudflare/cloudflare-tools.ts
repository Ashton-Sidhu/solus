import type { AgentTool } from '../agents/tools/agent-tool'
import { loadToken } from './token-store'

let notifyConnectNeeded: ((reason: 'deploy') => void) | null = null

export function setCloudflareConnectNeededListener(listener: (reason: 'deploy') => void): void {
  notifyConnectNeeded = listener
}

export const cloudflareStatusAgentTool: AgentTool = {
  name: 'cloudflare_status',
  description: 'Check whether Cloudflare deployment credentials are connected. Returns connection metadata only, never the API token.',
  inputFields: {} as const,
  requiresApproval: false,
  execute: async () => {
    const envToken = process.env.CLOUDFLARE_API_TOKEN
    if (envToken) {
      return { ok: true, text: JSON.stringify({ connected: true, source: 'env' }) }
    }
    const token = loadToken()
    if (token) {
      return { ok: true, text: JSON.stringify({ connected: true, accountName: token.accountName, source: 'stored' }) }
    }
    notifyConnectNeeded?.('deploy')
    return { ok: true, text: JSON.stringify({ connected: false }) }
  },
}
