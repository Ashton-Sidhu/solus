import { Building2, Cloud, FileSearch, FolderGit2, RefreshCw, Share2, ShieldCheck, SquareTerminal, Webhook } from '@lucide/svelte'
import type { Via } from '@solus/contracts/analytics-events'
import type { Command } from '../../command-palette/lib/commands'
import type { SettingsTab } from '../../../contexts/workspace/routing/route-registry'
import { EMPTY_WEBHOOKS_VIEW, serializeWebhooksView } from '../../webhooks/lib/webhooks-view'
import { mcpPageRequest } from './mcp-page-request.svelte'
import { codebasesPageRequest } from '../../codebases/lib/codebases-page-request.svelte'

/**
 * Palette entries for the settings pages that have an owner of their own
 * (plans/018 §7, plans/030 §7): personal sync, the organization, and policy.
 * Shared by desktop and web so both expose the same entry points.
 */
export function settingsOwnerCommands(shell: { showSettings(tab: SettingsTab, via: Via): void }): Command[] {
  return [{
    id: 'open-account-sync',
    label: 'Account & sync',
    group: 'General',
    icon: RefreshCw,
    keywords: ['sync', 'account', 'personal', 'devices', 'cloud', 'preferences', 'profile', 'hosts', 'sign in', 'address', 'self-hosted'],
    run: () => shell.showSettings('account', 'palette'),
  }, {
    id: 'open-organization-settings',
    label: 'Organization settings',
    group: 'General',
    icon: Building2,
    keywords: ['organization', 'projects', 'owner', 'team'],
    run: () => shell.showSettings('organization', 'palette'),
  }, {
    id: 'open-policy',
    label: 'Policy',
    group: 'General',
    icon: ShieldCheck,
    keywords: ['policy', 'managed', 'mdm', 'lock', 'permission', 'limit', 'insights', 'export', 'mobileconfig'],
    run: () => shell.showSettings('policy', 'palette'),
  }]
}

/**
 * The palette entries for Settings → Sharing & access (docs/outside-apps.md) and
 * Settings → Solus Cloud, shared
 * by desktop and web. The page opens on the host of the current session, else on
 * this device's host. "Use Solus in other apps" and "Approve an app sign-in"
 * open the same page for this device's host (fleet-commands.ts).
 */
export function sharingAccessCommands(shell: { showSettings(tab: SettingsTab, via: Via): void }): Command[] {
  return [{
    id: 'open-sharing-access',
    label: 'Sharing & access',
    group: 'General',
    icon: Share2,
    keywords: ['sharing', 'access', 'mcp', 'outside apps', 'connected apps', 'authorized clients', 'paired devices', 'pairing', 'revoke', 'pair code'],
    run: () => shell.showSettings('sharing', 'palette'),
  }, {
    id: 'open-solus-cloud',
    label: 'Solus Cloud',
    group: 'General',
    icon: Cloud,
    keywords: ['solus cloud', 'cloud', 'register', 'tunnel', 'internet', 'reachable', 'connection test', 'organizations'],
    run: () => shell.showSettings('cloud', 'palette'),
  }]
}

/** Palette entries for webhooks (docs/plans/webhooks.md §4), shared by desktop and web. */
export function webhookCommands(shell: { showSettings(tab: SettingsTab, via: Via, webhooks?: string): void }): Command[] {
  return [{
    id: 'open-webhooks',
    label: 'Open webhooks',
    group: 'General',
    icon: Webhook,
    keywords: ['webhook', 'hook', 'deliveries', 'sender', 'trigger'],
    run: () => shell.showSettings('webhooks', 'palette'),
  }, {
    id: 'new-webhook',
    label: 'New webhook',
    group: 'General',
    icon: Webhook,
    keywords: ['webhook', 'hook', 'create', 'sender', 'trigger'],
    run: () => shell.showSettings('webhooks', 'palette', serializeWebhooksView({ ...EMPTY_WEBHOOKS_VIEW, open: { kind: 'new', serverId: null } })),
  }]
}

/** Palette entries for codebases (docs/plans/codebases.md §9), shared by desktop and web. */
export function codebaseCommands(shell: { showSettings(tab: SettingsTab, via: Via): void }): Command[] {
  return [{
    id: 'open-codebases',
    label: 'Open codebases',
    group: 'General',
    icon: FolderGit2,
    keywords: ['codebase', 'folders', 'repositories', 'multi-repo', 'workspace'],
    run: () => shell.showSettings('codebases', 'palette'),
  }, {
    id: 'new-codebase',
    label: 'New codebase',
    group: 'General',
    icon: FolderGit2,
    keywords: ['codebase', 'create', 'folders', 'repositories', 'multi-repo', 'workspace'],
    run: () => {
      codebasesPageRequest.askNew()
      shell.showSettings('codebases', 'palette')
    },
  }]
}

/**
 * Palette entries for MCP servers, shared by desktop and web: a new server by
 * its command (docs/plans/mcp-first-class.md §7.7) or its address, and the
 * servers in the config files of the host (§8.6).
 */
export function mcpCommands(shell: { showSettings(tab: SettingsTab, via: Via): void }): Command[] {
  return [{
    id: 'add-mcp-command',
    label: 'Add an MCP server',
    group: 'General',
    icon: SquareTerminal,
    keywords: ['mcp', 'stdio', 'command', 'server', 'npx', 'uvx', 'local', 'integration', 'url', 'remote', 'http', 'address'],
    run: () => {
      mcpPageRequest.askAddServer()
      shell.showSettings('mcp', 'palette')
    },
  }, {
    id: 'find-mcp-servers',
    label: 'Find MCP servers on your hosts',
    group: 'General',
    icon: FileSearch,
    keywords: ['mcp', 'server', 'found', 'config', 'claude', 'codex', 'cursor', 'vscode', 'import', 'discover', 'host'],
    run: () => {
      mcpPageRequest.view = 'found'
      shell.showSettings('mcp', 'palette')
    },
  }]
}
