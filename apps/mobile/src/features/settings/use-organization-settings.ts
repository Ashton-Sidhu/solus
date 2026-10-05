import { useCallback } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useApp, useListened } from '../../app/app-context'
import type { OrganizationSettingsView } from './organization-settings'

const IDLE: OrganizationSettingsView = { kind: 'idle' }

/** One organization's settings for a screen: read on focus while signed in. */
export function useOrganizationSettings(organizationId: string | null) {
  const app = useApp()
  const isSignedIn = useListened(app.account.changes, () => app.account.isSignedIn)
  const view = useListened(app.organizationSettings.changes, () => (organizationId ? app.organizationSettings.viewOf(organizationId) : IDLE))
  const reload = useCallback(() => {
    if (organizationId && isSignedIn) void app.organizationSettings.load(organizationId)
  }, [app, organizationId, isSignedIn])
  useFocusEffect(reload)
  return { view, reload }
}
