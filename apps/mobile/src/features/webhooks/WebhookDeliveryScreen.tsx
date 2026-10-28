import { ActivityIndicator, Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { WebhookActionResult, WebhookDelivery } from "@solus/contracts/webhooks";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { HostStatusBanner } from "../hosts/HostStatusBanner";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsValueRow } from "../settings/components/SettingsValueRow";
import { errorMessage } from "../settings/integrations";
import { useWebhookDelivery } from "./use-webhook";
import { PillButton } from "./webhook-rows";
import {
  actionStatusLabel,
  actionTypeLabel,
  isFailingOutcome,
  outcomeLabel,
  sourceLabel,
  verificationFailureText,
} from "./webhooks";

const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString();

/**
 * One delivery (docs/plans/webhooks.md §3.3): its outcome, why nothing ran,
 * where it came from and when, and one result for each action with its
 * rendered prompt. Replay runs the stored request again for all actions or
 * for one, and opens the new delivery.
 */
export function WebhookDeliveryScreen({ navigation, route }: ScreenProps<"WebhookDelivery">) {
  const { hostId, webhookId, deliveryId } = route.params;
  const insets = useSafeAreaInsets();
  const { state, connected, replaying, reload, replay } = useWebhookDelivery(hostId, webhookId, deliveryId);

  const runReplay = (actionId?: string) => {
    replay(actionId).then(
      (summary) => navigation.push("WebhookDelivery", { hostId, webhookId, deliveryId: summary.id }),
      (cause: unknown) => Alert.alert("Not replayed", errorMessage(cause)),
    );
  };

  return (
    <SettingsScreen title="Delivery">
      <HostStatusBanner hostId={hostId} />
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!connected ? (
          <SettingsNote>Connect this host to see this delivery.</SettingsNote>
        ) : state.kind === "missing" ? (
          <SettingsNote>This delivery is no longer kept. The host keeps the last 200 deliveries or 14 days.</SettingsNote>
        ) : state.kind === "error" ? (
          <View className="gap-3">
            <ErrorBanner message={`The delivery could not be read: ${state.message}`} />
            <PillButton label="Try again" onPress={reload} />
          </View>
        ) : state.kind === "loading" ? (
          <View className="items-center py-2">
            <ActivityIndicator accessibilityLabel="Reading the delivery" colorClassName="accent-icon-muted" />
          </View>
        ) : (
          <>
            <SummarySection delivery={state.delivery} />
            {state.delivery.actions.length > 0 ? (
              <SettingsSection title="Actions">
                {state.delivery.actions.map((result, index) => (
                  <ActionResultRow key={result.actionId} result={result} first={index === 0} />
                ))}
              </SettingsSection>
            ) : null}
            <View className="gap-3">
              <SettingsSection title="Replay">
                <SettingsActionRow
                  icon="arrow.uturn.backward"
                  label="Replay all actions"
                  disabled={replaying}
                  loading={replaying}
                  onPress={() => runReplay()}
                />
                {state.delivery.actions.map((result) => (
                  <SettingsActionRow
                    key={result.actionId}
                    icon="arrow.uturn.backward"
                    label={`Replay only: ${actionTypeLabel(result.type)}`}
                    disabled={replaying}
                    onPress={() => runReplay(result.actionId)}
                  />
                ))}
              </SettingsSection>
              <SettingsNote>
                A replay runs the stored request again. It skips verification and the duplicate checks.
              </SettingsNote>
            </View>
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function SummarySection(props: { readonly delivery: WebhookDelivery }) {
  const { delivery } = props;
  const failing = isFailingOutcome(delivery.outcome);
  return (
    <View className="gap-3">
      <SettingsSection title="Delivery">
        <ListRowLayout
          icon={failing ? "exclamationmark.triangle" : "checkmark.circle"}
          label={outcomeLabel(delivery.outcome)}
          description={delivery.reason ?? undefined}
        />
        <SettingsValueRow icon="cloud" label="Source" value={sourceLabel(delivery.source)} />
        <SettingsValueRow icon="clock" label="Received" value={formatTime(delivery.receivedAt)} />
        {delivery.arrivedAt !== delivery.receivedAt ? (
          <SettingsValueRow icon="clock" label="Arrived" value={formatTime(delivery.arrivedAt)} />
        ) : null}
        <SettingsValueRow icon="doc.text" label="Method" value={delivery.request.method} />
      </SettingsSection>
      {delivery.verificationFailure ? (
        <SettingsNote tone="danger">{verificationFailureText(delivery.verificationFailure)}</SettingsNote>
      ) : null}
      {delivery.replayOf ? <SettingsNote>This delivery is a replay of an earlier delivery.</SettingsNote> : null}
    </View>
  );
}

function ActionResultRow(props: { readonly result: WebhookActionResult; readonly first: boolean }) {
  const { result } = props;
  const failedFilter = result.filters.find((entry) => !entry.matched)?.filter;
  return (
    <View className={props.first ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}>
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-base text-foreground">{actionTypeLabel(result.type)}</Text>
        <Text
          className={
            result.status === "failed" || result.status === "busy"
              ? "text-sm text-danger-foreground"
              : "text-sm text-foreground-muted"
          }
        >
          {actionStatusLabel(result.status)}
        </Text>
      </View>
      {result.error ? <Text selectable className="text-sm text-danger-foreground">{result.error}</Text> : null}
      {result.status === "skipped" && failedFilter ? (
        <Text className="text-sm text-foreground-muted">{`Filter did not match: ${failedFilter.path} ${failedFilter.op}`}</Text>
      ) : null}
      {result.missing.length > 0 ? (
        <Text className="text-sm text-foreground-muted">{`No value for: ${result.missing.join(", ")}`}</Text>
      ) : null}
      {result.prompt ? (
        <View className="rounded-xl bg-subtle px-3 py-2">
          <Text selectable className="font-mono text-xs text-foreground" numberOfLines={40}>
            {result.prompt}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
