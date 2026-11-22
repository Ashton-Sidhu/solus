import { permissionsAllow } from '@solus/contracts/permissions'
import { z } from 'zod'
import { isHostOwner } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { permissionsFor } from '../../../admission/access-policy'
import type { HostPairings } from '../../../host/host-pairings'
import { takeSecretRef } from '../../sessions/secret-requests'
import type { AgentTool } from './agent-tool'

let pairings: HostPairings | null = null
export function setHostPairingTools(next: HostPairings | null): void { pairings = next }

function forOwner(): HostPairings {
  const principal = workspaceToolAuthority()
  // No ambient/system fallback: a background agent cannot create owner access.
  if (!principal || !isHostOwner(principal) || principal.via !== 'local') throw new Error('Only a locally authorized owner session can manage host pairings.')
  if (!permissionsAllow(permissionsFor(principal), 'host.local.reach')) throw new Error('This host does not allow local host reach.')
  if (!pairings) throw new Error('Host pairing is not available on this server.')
  return pairings
}

export const pairHostAgentTool: AgentTool = {
  name: 'pair_host',
  description: 'Pair a remote Solus host for agent work and connected owner clients. Pass its address and a secretRef from request_secret for its code or link (solus pair on the remote). Never put codes in chat or tool input. Local owner only. list_hosts lists machines; remove_host forgets.',
  inputFields: {
    url: z.string().describe('The server address, with no pairing token, for example http://10.10.1.10:3000.'),
    secretRef: z.string().describe('One-use ref from request_secret for the pairing code or link.'),
    label: z.string().optional(),
  },
  requiresApproval: true,
  async execute(input, context) {
    try {
      const service = forOwner()
      const secret = takeSecretRef(input.secretRef, context.sessionId() ?? null)
      if (!secret) throw new Error('The secretRef is expired, already used, or belongs to another session. Ask with request_secret again.')
      const { parsePairLink, normalizeServerUrl } = await import('@solus/client-core/pairing')
      const link = parsePairLink(secret)
      if (link && normalizeServerUrl(input.url) !== link.url) throw new Error('The pairing link names a different server. Use the address from that link.')
      const host = await service.pair({ url: input.url, code: link?.pairToken ?? secret.trim(), label: input.label }, context.abortSignal)
      return { ok: true, text: JSON.stringify({ host, paired: true, note: 'Agents here can use this host with start_sessions. Connected owner clients get their own pairing through the host list.' }) }
    } catch (error) { return { ok: false, text: error instanceof Error ? error.message : 'Host pairing failed.' } }
  },
}

export const removeHostAgentTool: AgentTool = {
  name: 'remove_host',
  description: 'Forget a host here by installationId from list_hosts or pair_host. Clears credentials and forwards; connected owner clients forget it too. The remote server and sessions stay. Pair again to restore access.',
  inputFields: { installationId: z.string().min(1) }, requiresApproval: true,
  async execute(input) {
    try { return { ok: true, text: JSON.stringify({ removed: forOwner().forget(input.installationId) }) } }
    catch (error) { return { ok: false, text: error instanceof Error ? error.message : 'Could not forget the host.' } }
  },
}
