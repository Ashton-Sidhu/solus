import { relative, sep } from 'node:path'

import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// Every process the server starts acts as someone (plans/019-acting-identity.md):
// the host, or one member in a clean environment of their own. A child
// environment built from `process.env` hands a member the host's keys, tokens,
// and helpers without anyone deciding it; a host-only name used for a person's
// work does the same on purpose. Both are allowed only where the work is the
// host's by nature, and each such file is named here with its reason.
const guardedRoot = 'packages/server/src/'

/** Files whose processes are the host's own: they may build from `process.env`. */
const ambientEnvFiles = new Map([
  ['packages/server/src/cli-env.ts', 'defines the host environment'],
  ['packages/server/src/transport/ssh-bootstrap.ts', 'reaches another machine with the host’s own SSH'],
  ['packages/server/src/transport/uplink/connector.ts', 'runs the host’s tunnel'],
  ['packages/server/src/platform/trash.ts', 'moves the host’s files to its trash'],
  ['packages/server/src/browser/browser-runtime.ts', 'installs the host’s browser'],
  ['packages/server/src/devices/ssh-device-script.ts', 'drives the host’s device bridge'],
  ['packages/server/src/devices/device-agent-cli.ts', 'drives the host’s device bridge'],
])

/** Names that mean "the host itself", and the files that may use them. */
const hostNames = new Set(['HOST_ACTOR', 'HOST_IDENTITY', 'HOST_SCOPE', 'withHostScope', 'hostCliEnv'])
const hostNameFiles = new Map([
  ['packages/server/src/admission/actor.ts', 'defines the host actor'],
  ['packages/server/src/execution/seats/acting-identity.ts', 'defines the host identity'],
  ['packages/server/src/cli-env.ts', 'defines the host environment'],
  ['packages/server/src/boot-core.ts', 'boot is the host’s own work'],
  ['packages/server/src/boot-server.ts', 'boot is the host’s own work'],
  ['packages/server/src/boot-solus-api.ts', 'boot is the host’s own work'],
  ['packages/server/src/transport/server.ts', 'internal calls with no principal'],
  ['packages/server/src/execution/session-runtime.ts', 'turns with no actor are the host’s'],
  ['packages/server/src/execution/sessions/run-launcher.ts', 'turns with no actor are the host’s'],
  ['packages/server/src/execution/sessions/run-scheduler.ts', 'turns with no actor are the host’s'],
  ['packages/server/src/execution/sessions/restart-recovery.ts', 'recovery of the host’s own runs'],
  ['packages/server/src/execution/orchestration/orchestrate-sessions.ts', 'the orchestrator stops and answers as the host'],
  ['packages/server/src/execution/automations/automation-runner.ts', 'a system automation is the host’s'],
  ['packages/server/src/execution/agents/tools/worktree-tools.ts', 'a session with no known person'],
  ['packages/server/src/execution/agents/codex/codex-agent.ts', 'the host login’s shared app-server'],
  ['packages/server/src/providers/github/git-credential.ts', 'finds the installed Solus CLI'],
  ['packages/server/src/prs/pr-sync.ts', 'repositories only tasks want'],
  ['packages/server/src/code-intel/code-intel-manager.ts', 'language servers are shared host tools'],
  ['packages/server/src/code-intel/tool-installer.ts', 'installs host tools'],
  ['packages/server/src/transport/handlers/setup-commands.ts', 'probes and installs host tools'],
  ['packages/server/src/updates/provider-versions.ts', 'reads the host’s CLI versions'],
])

function repositoryPath(cwd: string, filename: string): string {
  return relative(cwd, filename).split(sep).join('/')
}

function isProcessEnv(node: ESTree.Node): boolean {
  return node.type === 'MemberExpression'
    && node.object.type === 'Identifier' && node.object.name === 'process'
    && node.property.type === 'Identifier' && node.property.name === 'env'
}

/** Keep processes acting as an identity, and the host's exceptions named. */
export const actingIdentityRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Start every server process from the acting identity, and name each place that acts as the host.',
    },
    messages: {
      ambientEnv:
        'Build this environment from the acting identity (getCliEnv or currentIdentity().env()). process.env carries the host’s keys and tokens into a member’s process (plans/019-acting-identity.md).',
      hostName:
        '{{name}} acts as the host. Use the acting scope for work done for a person, or add this file to the reviewed list in tools/oxlint/solus/rules/acting-identity.ts with its reason (plans/019-acting-identity.md).',
    },
  },
  create(context) {
    const path = repositoryPath(context.cwd, context.filename)
    if (!path.startsWith(guardedRoot)) return {}
    const ambientAllowed = ambientEnvFiles.has(path)
    const hostAllowed = hostNameFiles.has(path)
    return {
      SpreadElement(node) {
        if (!ambientAllowed && isProcessEnv(node.argument)) context.report({ node, messageId: 'ambientEnv' })
      },
      Property(node) {
        if (ambientAllowed || node.computed || node.key.type !== 'Identifier' || node.key.name !== 'env') return
        if (isProcessEnv(node.value)) context.report({ node: node.value, messageId: 'ambientEnv' })
      },
      Identifier(node) {
        if (hostAllowed || !hostNames.has(node.name)) return
        context.report({ node, messageId: 'hostName', data: { name: node.name } })
      },
    }
  },
})
