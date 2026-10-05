import type { OrganizationSettings, OrganizationSettingsResponse } from '@solus/contracts/settings'

/**
 * An owner's unsaved edit of one organization's settings (plans/018 §7), kept
 * apart from what was read, saved with the revision that was read, and never
 * queued offline. Today the only organization setting is Sync all Insights.
 */
export type OrganizationDraft = OrganizationSettings

export function draftFrom(settings: OrganizationSettingsResponse): OrganizationDraft {
  return { ...settings.settings }
}

/** The settings the draft changes, and only those: a save sends no key it did not change. */
export function changedSettings(base: OrganizationSettings, draft: OrganizationDraft): Partial<OrganizationSettings> {
  return base.syncAllInsights === draft.syncAllInsights ? {} : { syncAllInsights: draft.syncAllInsights }
}

export function isDraftDirty(settings: OrganizationSettingsResponse, draft: OrganizationDraft): boolean {
  return Object.keys(changedSettings(settings.settings, draft)).length > 0
}
