import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LOCAL_POLICY_ORGANIZATION_ID } from "@solus/contracts/policy";

import { useApp, useListened } from "../../app/app-context";
import type { AppSymbolName } from "../../components/AppSymbol";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { policyScreenModel, type PolicyRuleRow } from "./lib/policy-view";
import { useHostPolicy } from "./use-host-policy";

/**
 * The effective policy of work on one host (plans/030 §7): the MDM policy of
 * the machine, the organization's host policy for this host, and the
 * organization policy, first wins, with every lock and the policy that sets
 * it. Mobile shows policies but does not edit or export them (plan 030 O1);
 * owners edit them in Settings → Policy on desktop and web. Choosing an
 * organization here only chooses what the screen shows.
 */
export function PolicyScreen({ route }: ScreenProps<"Policy">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const directory = useListened(app.account.changes, () => app.account.directory);
  const isSignedIn = useListened(app.account.changes, () => app.account.isSignedIn);
  const deviceOrganizationId = useListened(app.account.changes, () => app.account.organizationId);
  const [hostId, setHostId] = useState<string | null>(route.params?.hostId ?? null);
  const [organizationId, setOrganizationId] = useState<string>(
    route.params?.organizationId ?? deviceOrganizationId ?? LOCAL_POLICY_ORGANIZATION_ID,
  );
  const selectedHostId = hostId ?? hosts[0]?.id ?? null;
  const host = hosts.find((candidate) => candidate.id === selectedHostId);
  const readiness = useListened(app.connections.changes, () =>
    selectedHostId ? app.connections.state(selectedHostId)?.readiness : undefined,
  );
  const policy = useHostPolicy(selectedHostId);

  useEffect(() => {
    if (isSignedIn && app.account.directory.kind === "idle") void app.account.refreshDirectory();
  }, [app, isSignedIn]);

  const organizations = useMemo(
    () => [
      { organizationId: LOCAL_POLICY_ORGANIZATION_ID, name: "Personal" },
      ...(directory.kind === "loaded" ? directory.organizations : []),
    ],
    [directory],
  );
  const names = useMemo(
    () => new Map(organizations.map((organization) => [organization.organizationId, organization.name])),
    [organizations],
  );
  const model = useMemo(
    () => (policy ? policyScreenModel(policy, organizationId, names) : null),
    [policy, organizationId, names],
  );

  return (
    <SettingsScreen title="Policy">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {hosts.length > 1 ? (
          <SettingsSection title="Host">
            {hosts.map((candidate, index) => (
              <SettingsChoiceRow
                key={candidate.id}
                separated={index > 0}
                label={candidate.label}
                selected={candidate.id === selectedHostId}
                onPress={() => setHostId(candidate.id)}
              />
            ))}
          </SettingsSection>
        ) : null}

        {organizations.length > 1 ? (
          <View className="gap-3">
            <SettingsSection title="Work of">
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

        {!host ? (
          <SettingsNote>Add a host to see the policies that govern its work.</SettingsNote>
        ) : !model ? (
          readiness === "ready" || readiness === "checking" || readiness === "reconnecting" ? (
            <View className="items-center py-2">
              <ActivityIndicator accessibilityLabel="Reading the policy" colorClassName="accent-icon-muted" />
            </View>
          ) : (
            <SettingsNote>{`Connect ${host.label} to read its policy.`}</SettingsNote>
          )
        ) : (
          <>
            {model.refusal ? <ErrorBanner message={model.refusal} /> : null}

            <View className="gap-3">
              <SettingsSection title="Policies that apply">
                {model.sources.length === 0 ? (
                  <ListRowLayout icon="lock.open" label="No policy" description="Nothing is managed. Your settings apply." />
                ) : (
                  model.sources.map((source) => (
                    <View
                      key={source.kind}
                      accessible
                      accessibilityLabel={`${source.heading}: ${source.name}. ${source.detail}`}
                    >
                      <ListRowLayout
                        icon={SOURCE_ICONS[source.kind]}
                        label={source.name}
                        description={`${source.heading} · ${source.detail}`}
                      />
                    </View>
                  ))
                )}
              </SettingsSection>
              <SettingsNote>
                {model.sources.length > 1
                  ? "When two policies set the same rule, the first one here wins."
                  : "Owners change organization policies in Solus on desktop or the web. An MDM policy changes on the machine."}
              </SettingsNote>
            </View>

            <RuleSection title="Limits" rows={model.limits} />
            <RuleSection title="Locked session settings" rows={model.settings} />
            <View className="gap-3">
              <RuleSection title={`${host.label} settings`} rows={model.hostKeys} />
              {model.hostOwner ? <SettingsNote>{model.hostOwner}</SettingsNote> : null}
            </View>

            {model.supportUrl ? (
              <SettingsSection title="Help">
                <SettingsActionRow
                  icon="arrow.up.right"
                  label="Open the support page"
                  onPress={() => {
                    if (model.supportUrl) void Linking.openURL(model.supportUrl);
                  }}
                />
              </SettingsSection>
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

const SOURCE_ICONS = {
  mdm: "desktopcomputer",
  host: "server.rack",
  organization: "person.2",
} as const satisfies Record<"mdm" | "host" | "organization", AppSymbolName>;

/** One group of locks; absent when no policy sets any of them. */
function RuleSection(props: { readonly title: string; readonly rows: readonly PolicyRuleRow[] }) {
  if (props.rows.length === 0) return null;
  return (
    <SettingsSection title={props.title}>
      {props.rows.map((row) => (
        <View
          key={row.label}
          accessible
          accessibilityLabel={`${row.label}: ${row.value}. Set by ${row.source}.`}
        >
          <ListRowLayout icon="lock" label={row.label} detail={row.value} description={`Set by ${row.source}`} />
        </View>
      ))}
    </SettingsSection>
  );
}
