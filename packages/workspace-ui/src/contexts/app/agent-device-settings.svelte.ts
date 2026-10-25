import type { AgentDeviceSettings, AgentDeviceSettingsPatch } from '@solus/contracts/agent-personal-request'
import { FONT_OVERRIDE_KEYS, FONT_PREFERENCE_KEYS } from '@solus/contracts/settings'
import { KEYBINDINGS } from '../../lib/keybindings/manifest'
import type { SettingsContext } from './settings.context.svelte'

/** This device's settings as an agent reads them: its choices, not its layout. */
export function agentDeviceSettingsOf(settings: SettingsContext): AgentDeviceSettings {
  const { values, layout } = settings.device
  return $state.snapshot({ ...values, zoomFactor: layout.zoomFactor, keybindings: layout.keybindings })
}

/**
 * Applies an agent's change through the same setters Settings uses, so the device
 * repaints, zooms, and moves analytics consent as it does for the person. A
 * shortcut for a binding this client does not have refuses the whole change.
 */
export function applyAgentDeviceSettings(settings: SettingsContext, patch: AgentDeviceSettingsPatch): boolean {
  if (patch.keybindings && Object.keys(patch.keybindings).some((id) => !(id in KEYBINDINGS))) return false
  for (const key of ['voiceModeEnabled', 'autoSendVoiceTranscripts', 'vadSilenceMs', 'defaultEditor', 'fallbackTerminal', 'fontSmoothing'] as const) {
    const value = patch[key]
    if (value !== undefined) settings.setDevice(key, value)
  }
  if (patch.clientAnalyticsEnabled !== undefined) settings.setClientAnalyticsEnabled(patch.clientAnalyticsEnabled)
  for (const fontKey of FONT_PREFERENCE_KEYS) {
    const family = patch[FONT_OVERRIDE_KEYS[fontKey]]
    if (family === null) settings.useSyncedFont(fontKey)
    else if (family !== undefined) settings.setFont(fontKey, family)
  }
  if (patch.zoomFactor !== undefined) settings.setZoomFactor(patch.zoomFactor)
  if (patch.keybindings) settings.setLayout('keybindings', patch.keybindings)
  return true
}
