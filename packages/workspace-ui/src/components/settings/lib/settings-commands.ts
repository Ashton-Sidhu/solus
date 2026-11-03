import { Building2, RefreshCw, ShieldCheck, Webhook } from '@lucide/svelte'
import type { Via } from '@solus/contracts/analytics-events'
import type { Command } from '../../command-palette/lib/commands'
import type { SettingsTab } from '../../../contexts/workspace/routing/route-registry'
import { EMPTY_WEBHOOKS_VIEW, serializeWebhooksView } from '../../webhooks/lib/webhooks-view'

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
    keywords: ['sync', 'account', 'personal', 'devices', 'cloud', 'preferences', 'profile', 'hosts'],
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
