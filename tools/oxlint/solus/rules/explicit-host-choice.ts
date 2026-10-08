import { relative, sep } from 'node:path'

import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// A reader names the owner of the host it means (docs/plans/host-model.md
// §3.3): the tab's host, the device, or the Run on host, through `hosts`. A
// direct pick from `serverConnections` let stores keep one copy of a fact that
// followed the wrong host; the usage meters and the mic both broke that way.
const hostChoiceMethods = new Set(['runOnHostId', 'localServerId', 'localHostApi'])

// The registry that answers these questions, and the readers that chose a
// host this way before the rule: the Run on picker's own flows and the
// device-only surfaces. Add a file here only for a new Run on or device surface.
const allowedFiles = new Set([
  'apps/client/src/App.svelte',
  'apps/client/src/components/input/lib/attachments.ts',
  'apps/desktop/src/renderer/App.svelte',
  'apps/desktop/src/renderer/shell/BrowserWebviewLayer.svelte',
  'apps/desktop/src/renderer/shell/desktop-attachments.svelte.ts',
  'packages/workspace-ui/src/components/automations/AutomationBuilder.svelte',
  'packages/workspace-ui/src/components/automations/AutomationLaunchpad.svelte',
  'packages/workspace-ui/src/components/browser/BrowserPane.svelte',
  'packages/workspace-ui/src/components/browser/BrowserStage.svelte',
  'packages/workspace-ui/src/components/insights/insights.store.svelte.ts',
  'packages/workspace-ui/src/components/insights/InsightsPage.svelte',
  'packages/workspace-ui/src/components/onboarding/onboarding.store.svelte.ts',
  'packages/workspace-ui/src/components/servers/project-picker.svelte.ts',
  'packages/workspace-ui/src/components/servers/run-on.ts',
  'packages/workspace-ui/src/components/session/unified-picker/lib/conversation-search.svelte.ts',
  'packages/workspace-ui/src/components/settings/lib/settings-host.svelte.ts',
  'packages/workspace-ui/src/components/settings/SettingsPage.svelte',
  'packages/workspace-ui/src/components/settings/SettingsTabKeybindings.svelte',
  'packages/workspace-ui/src/components/ui/ProjectFavicon.svelte',
  'packages/workspace-ui/src/contexts/app/runtime-boot.ts',
  'packages/workspace-ui/src/contexts/connections/servers.store.svelte.ts',
  'packages/workspace-ui/src/contexts/projects/projects.store.svelte.ts',
  'packages/workspace-ui/src/contexts/seats/agent-profile.store.svelte.ts',
  'packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts',
])

const checkedRoots = [
  'packages/workspace-ui/src/',
  'apps/desktop/src/renderer/',
  'apps/client/src/',
]

function repositoryPath(cwd: string, filename: string): string {
  return relative(cwd, filename).split(sep).join('/')
}

function isCheckedFile(path: string): boolean {
  if (path.startsWith('packages/workspace-ui/src/contexts/hosts/')) return false
  return checkedRoots.some((root) => path.startsWith(root)) && !allowedFiles.has(path)
}

function hostChoice(node: ESTree.MemberExpression): string | null {
  if (node.computed || node.property.type !== 'Identifier') return null
  if (node.object.type !== 'Identifier' || node.object.name !== 'serverConnections') return null
  return hostChoiceMethods.has(node.property.name) ? node.property.name : null
}

/** Require a reader to get its host from its owner, not pick one directly. */
export const explicitHostChoiceRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Require readers to get a host from its owner through hosts, not from serverConnections.',
    },
    messages: {
      implicitHost: 'Do not pick a host with serverConnections.{{method}}(). Name its owner: hosts.get(run.serverId) for a tab, hosts.device for this device, or hosts.runOn for the Run on picker.',
    },
  },
  create(context) {
    const path = repositoryPath(context.cwd, context.filename)
    if (!isCheckedFile(path)) return {}
    return {
      MemberExpression(node) {
        const method = hostChoice(node)
        if (method) context.report({ node, messageId: 'implicitHost', data: { method } })
      },
    }
  },
})
