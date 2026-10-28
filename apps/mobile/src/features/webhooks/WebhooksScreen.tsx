import { useState } from "react";
import { ActivityIndicator, Alert, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { HostWebhookSettings, Webhook } from "@solus/contracts/webhooks";
import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { HostStatusBanner } from "../hosts/HostStatusBanner";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { errorMessage } from "../settings/integrations";
import { OrganizationWebhooks } from "./OrganizationWebhooks";
import { useHasOrganization } from "./use-organization-webhooks";
import { useHostWebhookSettings, useWebhooks } from "./use-webhooks";
import { ChoiceChip, PillButton, WebhookListRow, type RowLine } from "./webhook-rows";
import {
  deliveries24hText,
  hostUrlMode,
  isFailingOutcome,
  lastDeliveryText,
  projectName,
  publicUrlPatch,
  reachabilityText,
  UNSUPPORTED_NOTE,
  UNVERIFIED_TEXT,
  unverifiedReason,
  urlModeLabel,
  webhookStateLabel,
} from "./webhooks";

type HostWebhookSettingsModel = ReturnType<typeof useHostWebhookSettings>;

/**
 * The webhooks of one host (docs/plans/webhooks.md §4, mobile version 1): the
 * list, and the host's two webhook settings. A row opens the webhook, with
 * Pause, Copy, and its deliveries. The editor, Rotate, and dry run are on
 * desktop and web for now. A person in an organization also gets the
 * Organization view (plan §2.7), which reads the organization's Solus API.
 */
export function WebhooksScreen({ navigation, route }: ScreenProps<"Webhooks">) {
  const { hostId } = route.params;
  const insets = useSafeAreaInsets();
  const { list, connected, reload } = useWebhooks(hostId);
  const hostSettings = useHostWebhookSettings(hostId);
  const settings = hostSettings.state.kind === "loaded" ? hostSettings.state.settings : null;
  const hasOrganization = useHasOrganization();
  const [view, setView] = useState<"host" | "organization">("host");
  const showsOrganization = hasOrganization && view === "organization";

  return (
    <SettingsScreen title="Webhooks">
      <HostStatusBanner hostId={hostId} />
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {hasOrganization ? (
          <View accessibilityRole="tablist" className="flex-row gap-2">
            <ChoiceChip role="tab" label="This host" selected={view === "host"} onPress={() => setView("host")} />
            <ChoiceChip role="tab" label="Organization" selected={view === "organization"} onPress={() => setView("organization")} />
          </View>
        ) : null}

        {/* A host that is not connected shows no rows: old rows would read as current. */}
        {showsOrganization ? (
          <OrganizationWebhooks />
        ) : !connected ? (
          <SettingsNote>Connect this host to see its webhooks.</SettingsNote>
        ) : list.kind === "unsupported" ? (
          <SettingsNote>{UNSUPPORTED_NOTE}</SettingsNote>
        ) : list.kind === "error" ? (
          <View className="gap-3">
            <ErrorBanner message={`Webhooks could not be read: ${list.message}`} />
            <PillButton label="Try again" onPress={reload} />
          </View>
        ) : list.kind === "loading" ? (
          <View className="items-center py-2">
            <ActivityIndicator accessibilityLabel="Reading webhooks" colorClassName="accent-icon-muted" />
          </View>
        ) : list.webhooks.length === 0 ? (
          <SettingsNote>
            No webhooks on this host. Ask an agent to make one, or make one in Settings on desktop or web.
          </SettingsNote>
        ) : (
          <SettingsSection title="Webhooks">
            {list.webhooks.map((webhook, index) => (
              <WebhookListRow
                key={webhook.id}
                first={index === 0}
                title={webhook.name}
                trailing={webhookStateLabel(webhook)}
                trailingTone={webhook.pausedByAdmin ? "danger" : "muted"}
                lines={webhookLines(webhook, settings, hostSettings.isPersonalHost)}
                onPress={() => navigation.navigate("Webhook", { hostId, webhookId: webhook.id })}
              />
            ))}
          </SettingsSection>
        )}

        {connected && !showsOrganization ? <HostWebhookSettingsSection model={hostSettings} /> : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function webhookLines(webhook: Webhook, settings: HostWebhookSettings | null, isPersonalHost: boolean): RowLine[] {
  const now = Date.now();
  const project = projectName(webhook.project);
  const reachability = reachabilityText(webhook.urlMode, settings, isPersonalHost);
  const reason = unverifiedReason(webhook);
  const lines: RowLine[] = [
    { text: [project, urlModeLabel(webhook.urlMode)].filter(Boolean).join(" · ") },
    {
      text: lastDeliveryText(webhook.lastDelivery, now),
      tone: webhook.lastDelivery && isFailingOutcome(webhook.lastDelivery.outcome) ? "danger" : "muted",
    },
    { text: deliveries24hText(webhook.deliveries24h) },
  ];
  if (webhook.urlMode === "none" && reachability) lines.push({ text: reachability, tone: "danger" });
  if (reason !== null) lines.push({ text: `${UNVERIFIED_TEXT} Reason: ${reason}`, tone: "danger" });
  return lines;
}

/** The host's Public URL and, for a linked host, Hold webhooks while offline (plan §2.3, §4). */
function HostWebhookSettingsSection(props: { readonly model: HostWebhookSettingsModel }) {
  const { state, isAdmin, isPersonalHost, reload, update } = props.model;
  if (state.kind === "unsupported") return null;
  if (state.kind === "error") {
    return (
      <View className="gap-3">
        <ErrorBanner message={`Webhook settings could not be read: ${state.message}`} />
        <PillButton label="Try again" onPress={reload} />
      </View>
    );
  }
  if (state.kind === "loading") return null;
  const { settings } = state;

  const change = (patch: Parameters<typeof update>[0]) => {
    update(patch).catch((cause: unknown) => Alert.alert("Not changed", errorMessage(cause)));
  };

  const editPublicUrl = () => {
    const commit = (value: string) => {
      const parsed = publicUrlPatch(value);
      if (!parsed.ok) {
        Alert.alert("Not changed", parsed.message);
        return;
      }
      if (parsed.publicUrl === settings.publicUrl) return;
      change({ publicUrl: parsed.publicUrl });
    };
    const title = "Public URL";
    const message = "The address where this host is reachable, for example through a reverse proxy. Leave it empty to remove it.";
    if (Platform.OS === "ios") {
      Alert.prompt(title, message, (value) => commit(value ?? ""), "plain-text", settings.publicUrl ?? "", "url");
      return;
    }
    showTextInputDialog({ title, initialValue: settings.publicUrl ?? "", confirmText: "Save", onConfirm: commit });
  };

  const reachability = reachabilityText(hostUrlMode(settings), settings, isPersonalHost);
  return (
    <View className="gap-3">
      <SettingsSection title="This host">
        {settings.holdWhileOffline !== null ? (
          <SettingsSwitchRow
            icon="cloud"
            label="Hold webhooks while offline"
            disabled={!isAdmin}
            value={settings.holdWhileOffline}
            onValueChange={(next) => change({ holdWhileOffline: next })}
          />
        ) : null}
        <SettingsRow
          icon="globe"
          label="Public URL"
          value={settings.publicUrl ?? "Not set"}
          valuePosition="below"
          disabled={!isAdmin}
          onPress={editPublicUrl}
        />
      </SettingsSection>
      <SettingsNote>{`${urlModeLabel(hostUrlMode(settings))}. ${reachability ?? ""}`.trim()}</SettingsNote>
      {!isAdmin ? <SettingsNote>Only a host administrator can change these settings.</SettingsNote> : null}
    </View>
  );
}
