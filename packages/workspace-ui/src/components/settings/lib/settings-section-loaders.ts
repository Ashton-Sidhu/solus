/** Start the selected section beside the frame, without loading closed sections. */
export const settingsSectionLoaders = {
  'source-control': () => import('../SettingsTabSourceControl.svelte'),
  'general': () => import('../SettingsTabGeneral.svelte'),
  'chat': () => import('../SettingsTabChat.svelte'),
  'sessions': () => import('../SettingsTabSessions.svelte'),
  'tasks': () => import('../SettingsTabTasks.svelte'),
  'account': () => import('../SettingsTabAccount.svelte'),
  'agent-profile': () => import('../SettingsTabAgentProfile.svelte'),
  'organization': () => import('../SettingsTabOrganization.svelte'),
  'policy': () => import('../policy/PolicyPage.svelte'),
  'host': () => import('../SettingsTabHost.svelte'),
  'appearance': () => import('../SettingsTabAppearance.svelte'),
  'notifications': () => import('../SettingsTabNotifications.svelte'),
  'review': () => import('../SettingsTabReview.svelte'),
  'voice': () => import('../SettingsTabVoice.svelte'),
  'voiceDictionary': () => import('../VoiceDictionaryField.svelte'),
  'analytics': () => import('../AnalyticsSettings.svelte'),
  'telemetry': () => import('../SettingsTabTelemetry.svelte'),
  'experimental': () => import('../SettingsTabExperimental.svelte'),
  'providers': () => import('../SettingsTabProviders.svelte'),
  'api-access': () => import('../../connections/ConnectionsPanel.svelte'),
  'tools': () => import('../SettingsTabTools.svelte'),
  'integrations': () => import('../IntegrationAccounts.svelte'),
  'mcp': () => import('../SettingsTabMcp.svelte'),
  'skills': () => import('../SettingsTabSkills.svelte'),
  'devices': () => import('../../devices/DeviceSettings.svelte'),
  'webhooks': () => import('../../webhooks/SettingsTabWebhooks.svelte'),
  'codebases': () => import('../../codebases/SettingsTabCodebases.svelte'),
  'keybindings': () => import('../SettingsTabKeybindings.svelte'),
  projects: () => import('../SettingsTabProviders.svelte'),
}

type SettingsSectionName = keyof typeof settingsSectionLoaders
type SettingsSectionModule<Name extends SettingsSectionName> = Awaited<ReturnType<(typeof settingsSectionLoaders)[Name]>>

const loadedSections = new Map<SettingsSectionName, SettingsSectionModule<SettingsSectionName>>()

/**
 * The module of a section. A loaded section comes back as the module itself, not a promise,
 * so `{#await}` renders it at once. A promise always shows the pending branch for a few frames,
 * even when the module is already loaded, and that flashes the section skeleton.
 */
export function settingsSection<Name extends SettingsSectionName>(
  name: Name,
): SettingsSectionModule<Name> | Promise<SettingsSectionModule<Name>> {
  const loaded = loadedSections.get(name)
  if (loaded) {
    // SAFETY: the map stores each module under the name of the loader that gave it.
    return loaded as SettingsSectionModule<Name>
  }
  return settingsSectionLoaders[name]().then((module) => {
    loadedSections.set(name, module)
    // SAFETY: `module` comes from `settingsSectionLoaders[name]`, so it is the module of `name`.
    return module as SettingsSectionModule<Name>
  })
}
