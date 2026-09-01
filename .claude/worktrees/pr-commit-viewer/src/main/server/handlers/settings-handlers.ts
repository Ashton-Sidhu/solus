import { setAgentTaskLifecyclePolicy, setAnalyticsConsent } from '../settings'
import type { SolusServer } from '../server'
import type { AgentTaskLifecyclePolicy } from '../../../shared/types'

export function registerSettingsHandlers(server: SolusServer): void {
  server.register('setAnalyticsConsent', (args) => {
    const [enabled] = args as [boolean]
    setAnalyticsConsent(enabled === true)
  })

  server.register('setAgentTaskLifecyclePolicy', (args) => {
    const [policy] = args as [AgentTaskLifecyclePolicy]
    if (policy !== 'none' && policy !== 'moderate' && policy !== 'autonomous') {
      throw new Error('Invalid agent task lifecycle policy.')
    }
    return {
      agentTaskLifecyclePolicy: setAgentTaskLifecyclePolicy(policy).agentTaskLifecyclePolicy,
    }
  })
}
