import { useEffect, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { Banner, Button } from '../../ui/primitives'
import { ActionRow, ChoiceRow, GroupedFooter, GroupedScroll, GroupedSection, NavigationRow, SwitchRow, ValueRow } from '../../ui/grouped-rows'
import { useOrganizationSettings } from './use-organization-settings'

/**
 * One organization's settings (plans/018 §7): today only Sync all Insights.
 * Members see the value; owners (`canManageSettings`) edit a draft and save it
 * against the revision they read. Choosing an organization here only chooses
 * what this screen shows: it changes no session's organization. Hosts,
 * packages, and the setup script stay in the Solus console.
 */
export function OrganizationSettingsScreen({ navigation, route }: ScreenProps<'OrganizationSettings'>) {
  const app = useApp()
  const account = useListened(app.account.changes, () => app.account.view)
  const directory = useListened(app.account.changes, () => app.account.directory)
  const deviceOrganizationId = useListened(app.account.changes, () => app.account.organizationId)
  const [organizationId, setOrganizationId] = useState<string | null>(route.params?.organizationId ?? deviceOrganizationId)
  const { view, reload } = useOrganizationSettings(organizationId)
  const organizations = directory.kind === 'loaded' ? directory.organizations : []

  useEffect(() => {
    if (account.kind === 'signed-in' && app.account.directory.kind === 'idle') void app.account.refreshDirectory()
  }, [app, account.kind])

  useEffect(() => {
    if (!organizationId && organizations[0]) setOrganizationId(organizations[0].organizationId)
  }, [organizationId, organizations])

  if (account.kind !== 'signed-in') {
    return (
      <GroupedScroll>
        <GroupedSection footer="Organization settings belong to your Solus Cloud account.">
          <NavigationRow icon="signIn" label="Sign in to Solus Cloud" onPress={() => navigation.navigate('CloudSignIn')} />
        </GroupedSection>
      </GroupedScroll>
    )
  }

  const store = app.organizationSettings

  return (
    <GroupedScroll>
      {organizations.length > 1 ? (
        <GroupedSection title="Organization" footer="Choosing one here does not change which organization your sessions belong to.">
          {organizations.map((organization, index) => (
            <ChoiceRow key={organization.organizationId} isFirst={index === 0} label={organization.name} selected={organization.organizationId === organizationId} onPress={() => setOrganizationId(organization.organizationId)} />
          ))}
        </GroupedSection>
      ) : null}

      {directory.kind === 'loaded' && organizations.length === 0 ? (
        <GroupedFooter text="Your account is not in an organization." />
      ) : null}

      {view.kind === 'loading' || view.kind === 'idle' ? (
        organizationId ? <View style={{ padding: 24 }}><ActivityIndicator accessibilityLabel="Reading organization settings" /></View> : null
      ) : view.kind === 'forbidden' ? (
        <Banner message="You can no longer see this organization’s settings. Your membership or role may have changed." action={<Button label="Try again" onPress={reload} />} />
      ) : view.kind === 'signed-out' ? (
        <Banner message="Your Solus session ended. Sign in again to see organization settings." action={<Button label="Sign in" onPress={() => navigation.navigate('CloudSignIn')} />} />
      ) : view.kind === 'offline' ? (
        <Banner message="Solus Cloud did not answer. Check your connection." action={<Button label="Try again" onPress={reload} />} />
      ) : view.kind === 'error' ? (
        <Banner message={`Organization settings could not be read: ${view.message}`} action={<Button label="Try again" onPress={reload} />} />
      ) : (() => {
        const { settings, draft, saving, conflict, saveError } = view
        const canEdit = settings.canManageSettings && !saving
        const syncAllInsights = (draft ?? settings.settings).syncAllInsights
        return (
          <>
            <GroupedFooter text={settings.canManageSettings
              ? `You own ${settings.name}. This setting applies to its work on every host, from the next turn.`
              : `${settings.name}’s owners set this for its work. Only an owner can change it.`} />

            {conflict ? <Banner message="Another owner saved these settings first. Their values are below your changes. Save again to replace them, or cancel to keep theirs." /> : null}
            {saveError ? <Banner message={saveError} /> : null}

            <GroupedSection
              title="Insights"
              footer={syncAllInsights
                ? 'On: every session of this organization sends its Insights to the organization. Members cannot turn it off.'
                : 'Off: Insights go only from managed machines, from explicit shares, and from hosts that opt in.'}
            >
              {canEdit ? (
                <SwitchRow label="Sync all Insights" value={syncAllInsights} onChange={(on) => organizationId && store.edit(organizationId, { syncAllInsights: on })} />
              ) : (
                <ValueRow label="Sync all Insights" value={syncAllInsights ? 'On' : 'Off'} />
              )}
            </GroupedSection>
            {settings.settings.syncAllInsights && draft && !draft.syncAllInsights ? (
              <GroupedFooter text="Saving stops Sync all Insights. Insights then go only from managed machines, explicit shares, and hosts that opt in." />
            ) : null}

            {draft ? (
              <GroupedSection>
                <ActionRow label="Save" tone="accent" busy={saving} onPress={() => organizationId && void store.save(organizationId)} />
                <ActionRow isFirst={false} label="Cancel" disabled={saving} onPress={() => organizationId && store.cancel(organizationId)} />
              </GroupedSection>
            ) : null}

            <GroupedFooter text="Hosts, default packages, and the setup script of this organization are in the Solus console." />
          </>
        )
      })()}
    </GroupedScroll>
  )
}
