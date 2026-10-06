// Adapted from T3 Code apps/mobile/src/features/settings/SettingsThreadsRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useApp, useListened } from "../../app/app-context";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { useOrganizationSettings } from "./use-organization-settings";

/**
 * One organization's settings (plans/018 §7): today only Sync all Insights.
 * Members see the value; owners (`canManageSettings`) edit a draft and save it
 * against the revision they read. Choosing an organization here only chooses
 * what this screen shows: it changes no session's organization. Hosts,
 * packages, and the setup script stay in the Solus console.
 */
export function OrganizationSettingsScreen({
  navigation,
  route,
}: ScreenProps<"OrganizationSettings">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const account = useListened(app.account.changes, () => app.account.view);
  const directory = useListened(app.account.changes, () => app.account.directory);
  const deviceOrganizationId = useListened(app.account.changes, () => app.account.organizationId);
  const [organizationId, setOrganizationId] = useState<string | null>(
    route.params?.organizationId ?? deviceOrganizationId,
  );
  const { view, reload } = useOrganizationSettings(organizationId);
  const organizations = directory.kind === "loaded" ? directory.organizations : [];

  useEffect(() => {
    if (account.kind === "signed-in" && app.account.directory.kind === "idle")
      void app.account.refreshDirectory();
  }, [app, account.kind]);

  useEffect(() => {
    if (!organizationId && organizations[0]) setOrganizationId(organizations[0].organizationId);
  }, [organizationId, organizations]);

  const frame = (children: ReactNode) => (
    <SettingsScreen title="Organization">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {children}
      </ScrollView>
    </SettingsScreen>
  );

  if (account.kind !== "signed-in") {
    return frame(
      <View className="gap-3">
        <SettingsSection>
          <SettingsRow
            icon="person.crop.circle"
            label="Sign in to Solus Cloud"
            onPress={() => navigation.navigate("CloudSignIn")}
          />
        </SettingsSection>
        <SettingsNote>Organization settings belong to your Solus Cloud account.</SettingsNote>
      </View>,
    );
  }

  const store = app.organizationSettings;

  return frame(
    <>
      {organizations.length > 1 ? (
        <View className="gap-3">
          <SettingsSection title="Organization">
            {organizations.map((organization, index) => (
              <SettingsChoiceRow
                key={organization.organizationId}
                separated={index > 0}
                label={organization.name}
                selected={organization.organizationId === organizationId}
                onPress={() => setOrganizationId(organization.organizationId)}
              />
            ))}
          </SettingsSection>
          <SettingsNote>
            Choosing one here does not change which organization your sessions belong to.
          </SettingsNote>
        </View>
      ) : null}

      {directory.kind === "loaded" && organizations.length === 0 ? (
        <SettingsNote>Your account is not in an organization.</SettingsNote>
      ) : null}

      {view.kind === "loading" || view.kind === "idle" ? (
        organizationId ? (
          <View className="items-center py-2">
            <ActivityIndicator
              accessibilityLabel="Reading organization settings"
              colorClassName="accent-icon-muted"
            />
          </View>
        ) : null
      ) : view.kind === "forbidden" ? (
        <RetryNotice
          message="You can no longer see this organization’s settings. Your membership or role may have changed."
          label="Try again"
          onPress={reload}
        />
      ) : view.kind === "signed-out" ? (
        <RetryNotice
          message="Your Solus session ended. Sign in again to see organization settings."
          label="Sign in"
          onPress={() => navigation.navigate("CloudSignIn")}
        />
      ) : view.kind === "offline" ? (
        <RetryNotice
          message="Solus Cloud did not answer. Check your connection."
          label="Try again"
          onPress={reload}
        />
      ) : view.kind === "error" ? (
        <RetryNotice
          message={`Organization settings could not be read: ${view.message}`}
          label="Try again"
          onPress={reload}
        />
      ) : (
        (() => {
          const { settings, draft, saving, conflict, saveError } = view;
          const canEdit = settings.canManageSettings && !saving;
          const syncAllInsights = (draft ?? settings.settings).syncAllInsights;
          return (
            <>
              <SettingsNote>
                {settings.canManageSettings
                  ? `You own ${settings.name}. This setting applies to its work on every host, from the next turn.`
                  : `${settings.name}’s owners set this for its work. Only an owner can change it.`}
              </SettingsNote>

              {conflict ? (
                <ErrorBanner message="Another owner saved these settings first. Their values are below your changes. Save again to replace them, or cancel to keep theirs." />
              ) : null}
              {saveError ? <ErrorBanner message={saveError} /> : null}

              <View className="gap-3">
                <SettingsSection title="Insights">
                  {canEdit ? (
                    <SettingsSwitchRow
                      icon="chart.bar.xaxis"
                      label="Sync all Insights"
                      value={syncAllInsights}
                      onValueChange={(on) =>
                        organizationId && store.edit(organizationId, { syncAllInsights: on })
                      }
                    />
                  ) : (
                    <SettingsValueRow
                      icon="chart.bar.xaxis"
                      label="Sync all Insights"
                      value={syncAllInsights ? "On" : "Off"}
                    />
                  )}
                </SettingsSection>
                <SettingsNote>
                  {syncAllInsights
                    ? "On: every session of this organization sends its Insights to the organization. Members cannot turn it off."
                    : "Off: Insights go only from managed machines, from explicit shares, and from hosts that opt in."}
                </SettingsNote>
                {settings.settings.syncAllInsights && draft && !draft.syncAllInsights ? (
                  <SettingsNote>
                    Saving stops Sync all Insights. Insights then go only from managed machines,
                    explicit shares, and hosts that opt in.
                  </SettingsNote>
                ) : null}
              </View>

              {draft ? (
                <SettingsSection>
                  <SettingsActionRow
                    icon="checkmark"
                    label="Save"
                    loading={saving}
                    disabled={saving}
                    onPress={() => organizationId && void store.save(organizationId)}
                  />
                  <SettingsActionRow
                    icon="xmark"
                    label="Cancel"
                    disabled={saving}
                    onPress={() => organizationId && store.cancel(organizationId)}
                  />
                </SettingsSection>
              ) : null}

              <SettingsNote>
                Hosts, default packages, and the setup script of this organization are in the Solus
                console.
              </SettingsNote>
            </>
          );
        })()
      )}
    </>,
  );
}

/** A refused or failed read, and the one way forward. */
function RetryNotice({
  message,
  label,
  onPress,
}: {
  readonly message: string;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <View className="gap-3">
      <ErrorBanner message={message} />
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        className="self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
      >
        <Text className="text-xs font-t3-bold text-foreground">{label}</Text>
      </Pressable>
    </View>
  );
}
