import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Webhook, WebhookDeliverySummary } from "@solus/contracts/webhooks";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { relativeTime } from "../../lib/time";
import type { ScreenProps } from "../../navigation/routes";
import { HostStatusBanner } from "../hosts/HostStatusBanner";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { errorMessage } from "../settings/integrations";
import { useWebhook, type DeliveryListState } from "./use-webhook";
import { useHostWebhookSettings } from "./use-webhooks";
import { PillButton, WebhookListRow, type RowLine } from "./webhook-rows";
import {
  actionTypeLabel,
  isFailingOutcome,
  lostText,
  outcomeLabel,
  PAUSED_BY_ADMIN_TEXT,
  pauseControl,
  projectName,
  reachabilityText,
  sourceLabel,
  UNVERIFIED_TEXT,
  unverifiedReason,
  URL_CHANGED_TEXT,
  urlModeLabel,
  webhookStateLabel,
} from "./webhooks";

const COPIED_FEEDBACK_MS = 1200;

/**
 * One webhook on the phone (docs/plans/webhooks.md §4): Pause or Resume,
 * Copy URL with how the host is reached, and the deliveries, newest first.
 * The owner alone gets the URL; an admin pause has no Resume here.
 */
export function WebhookScreen({ navigation, route }: ScreenProps<"Webhook">) {
  const { hostId, webhookId } = route.params;
  const insets = useSafeAreaInsets();
  const model = useWebhook(hostId, webhookId);
  const hostSettings = useHostWebhookSettings(hostId);
  const { webhook, connected } = model;
  const title = webhook.kind === "loaded" ? webhook.webhook.name : "Webhook";

  return (
    <SettingsScreen title={title}>
      <HostStatusBanner hostId={hostId} />
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!connected ? (
          <SettingsNote>Connect this host to see this webhook.</SettingsNote>
        ) : webhook.kind === "missing" ? (
          <SettingsNote>This webhook no longer exists.</SettingsNote>
        ) : webhook.kind === "error" ? (
          <View className="gap-3">
            <ErrorBanner message={`The webhook could not be read: ${webhook.message}`} />
            <PillButton label="Try again" onPress={model.reload} />
          </View>
        ) : webhook.kind === "loading" ? (
          <View className="items-center py-2">
            <ActivityIndicator accessibilityLabel="Reading the webhook" colorClassName="accent-icon-muted" />
          </View>
        ) : (
          <>
            <StateSection webhook={webhook.webhook} model={model} />
            <UrlSection
              webhook={webhook.webhook}
              model={model}
              reachability={reachabilityText(
                webhook.webhook.urlMode,
                hostSettings.state.kind === "loaded" ? hostSettings.state.settings : null,
                hostSettings.isPersonalHost,
              )}
            />
            <ActionsSection webhook={webhook.webhook} />
            <DeliveriesSection
              webhook={webhook.webhook}
              deliveries={model.deliveries}
              onRetry={model.reload}
              onLoadMore={model.loadMore}
              onOpen={(delivery) =>
                navigation.navigate("WebhookDelivery", { hostId, webhookId, deliveryId: delivery.id })
              }
            />
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

type WebhookModel = ReturnType<typeof useWebhook>;

function StateSection(props: { readonly webhook: Webhook; readonly model: WebhookModel }) {
  const { webhook, model } = props;
  const control = pauseControl(webhook);
  const project = projectName(webhook.project);
  const setEnabled = (enabled: boolean) => {
    model.setEnabled(enabled).catch((cause: unknown) =>
      Alert.alert(enabled ? "Not resumed" : "Not paused", errorMessage(cause)),
    );
  };
  return (
    <View className="gap-3">
      <SettingsSection title="State">
        <ListRowLayout
          icon="bolt.horizontal.circle"
          label={webhookStateLabel(webhook)}
          description={project ? `Project: ${project}` : undefined}
        />
        {control === "pause" ? (
          <SettingsActionRow
            icon="stop.fill"
            label="Pause"
            disabled={model.busy !== null}
            loading={model.busy === "pause"}
            onPress={() => setEnabled(false)}
          />
        ) : control === "resume" ? (
          <SettingsActionRow
            icon="play"
            label="Resume"
            disabled={model.busy !== null}
            loading={model.busy === "pause"}
            onPress={() => setEnabled(true)}
          />
        ) : null}
      </SettingsSection>
      {webhook.pausedByAdmin ? (
        <SettingsNote tone="danger">{`${PAUSED_BY_ADMIN_TEXT}. Only an organization admin can resume it.`}</SettingsNote>
      ) : !webhook.enabled ? (
        <SettingsNote>A paused webhook refuses requests and replays.</SettingsNote>
      ) : null}
    </View>
  );
}

function UrlSection(props: {
  readonly webhook: Webhook;
  readonly model: WebhookModel;
  readonly reachability: string | null;
}) {
  const { webhook, model } = props;
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);
  const reason = unverifiedReason(webhook);

  const copy = () => {
    model.copyUrl().then(
      (target) => {
        if (target.kind === "url") {
          setCopied(true);
          if (resetTimer.current) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
        } else if (target.kind === "no_url") {
          Alert.alert("No URL", "Link this host to Solus Cloud, or set its public URL.");
        } else if (target.kind === "not_owner") {
          Alert.alert("Not copied", "Only the owner of this webhook can copy its URL.");
        } else {
          Alert.alert("Not copied", "This webhook no longer exists.");
        }
      },
      (cause: unknown) => Alert.alert("Not copied", errorMessage(cause)),
    );
  };

  return (
    <View className="gap-3">
      <SettingsSection title="URL">
        <ListRowLayout icon="link" label={urlModeLabel(webhook.urlMode)} />
        <SettingsActionRow
          icon={copied ? "checkmark" : "doc.on.doc"}
          label={copied ? "Copied" : "Copy URL"}
          disabled={model.busy !== null || webhook.urlMode === "none"}
          loading={model.busy === "copy"}
          onPress={copy}
        />
      </SettingsSection>
      {webhook.urlChanged ? <SettingsNote tone="danger">{`${URL_CHANGED_TEXT}. Give the sender the new URL.`}</SettingsNote> : null}
      {props.reachability ? <SettingsNote>{props.reachability}</SettingsNote> : null}
      {reason !== null ? <SettingsNote tone="danger">{`${UNVERIFIED_TEXT} Reason: ${reason}`}</SettingsNote> : null}
    </View>
  );
}

function ActionsSection(props: { readonly webhook: Webhook }) {
  return (
    <SettingsSection title="Actions">
      {props.webhook.actions.map((action) => (
        <ListRowLayout
          key={action.id}
          icon="bolt.circle"
          label={actionTypeLabel(action.type)}
          description={[
            action.enabled ? null : "Off",
            action.filters.length === 0
              ? "Runs for every delivery"
              : action.filters.length === 1
                ? "1 filter"
                : `${action.filters.length} filters`,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
    </SettingsSection>
  );
}

function DeliveriesSection(props: {
  readonly webhook: Webhook;
  readonly deliveries: DeliveryListState;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
  readonly onOpen: (delivery: WebhookDeliverySummary) => void;
}) {
  const { deliveries } = props;
  const lost = lostText(props.webhook.lostCount);
  if (deliveries.kind === "error") {
    return (
      <View className="gap-3">
        <ErrorBanner message={`Deliveries could not be read: ${deliveries.message}`} />
        <PillButton label="Try again" onPress={props.onRetry} />
      </View>
    );
  }
  if (deliveries.kind === "loading") {
    return (
      <View className="items-center py-2">
        <ActivityIndicator accessibilityLabel="Reading deliveries" colorClassName="accent-icon-muted" />
      </View>
    );
  }
  const now = Date.now();
  return (
    <View className="gap-3">
      {lost ? <SettingsNote tone="danger">{lost}</SettingsNote> : null}
      {deliveries.deliveries.length === 0 ? (
        <SettingsNote>No deliveries yet. A request to the URL shows here.</SettingsNote>
      ) : (
        <SettingsSection title="Deliveries">
          {deliveries.deliveries.map((delivery, index) => (
            <WebhookListRow
              key={delivery.id}
              first={index === 0}
              title={outcomeLabel(delivery.outcome)}
              trailing={relativeTime(new Date(delivery.receivedAt).toISOString(), now)}
              lines={deliveryLines(delivery)}
              onPress={() => props.onOpen(delivery)}
            />
          ))}
        </SettingsSection>
      )}
      {deliveries.hasMore ? (
        <PillButton label="Show more" disabled={deliveries.loadingMore} onPress={props.onLoadMore} />
      ) : null}
    </View>
  );
}

function deliveryLines(delivery: WebhookDeliverySummary): RowLine[] {
  const lines: RowLine[] = [{ text: delivery.replayOf ? `${sourceLabel(delivery.source)} · Replay` : sourceLabel(delivery.source) }];
  if (delivery.reason) lines.push({ text: delivery.reason, tone: isFailingOutcome(delivery.outcome) ? "danger" : "muted" });
  return lines;
}
