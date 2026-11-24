import { useState, type ReactNode } from "react";
import { Alert, View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  lastReachedText,
  machineLinkStateText,
  machineLinkTone,
  machineLinksHiddenText,
  type MachineLinkState,
  type MachineLinkTone,
} from "@solus/client-core/host-linking";
import { routeKindLabel } from "@solus/client-core/host-route-control";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  readLinkHealth,
  refreshMachineLinks,
  useKnownMachineIds,
  useLinkHealth,
  useMachineLinks,
  useMachineLinksHidden,
} from "../../solus/use-machine-links";
import { useConnectSolusMachine } from "../../solus/use-connect-solus-machine";
import {
  linkAddresses,
  linkBack,
  linkExpiryText,
  linkHealthSources,
  linkedDateText,
  machineLinkRows,
  type MachineLinkRow,
} from "../../solus/machine-link-rows";
import { connectionTone } from "./connectionTone";

/** The tones of the connection rows: a link that works, may soon fail, fails, or cannot tell. */
const TONE_PHASE = {
  ok: "connected",
  warn: "reconnecting",
  bad: "error",
  unknown: "available",
} as const satisfies Record<MachineLinkTone, Parameters<typeof connectionTone>[0]>;

function linkStateTone(state: MachineLinkState): StatusTone {
  return { ...connectionTone(TONE_PHASE[machineLinkTone(state)]), label: machineLinkStateText(state) };
}

export function LinkedEnvironmentsSection(props: {
  readonly environmentId: EnvironmentId | string;
  readonly environmentLabel: string;
  readonly children?: ReactNode;
}) {
  const sourceId = props.environmentId;
  const machines = useMachineLinks();
  const hidden = useMachineLinksHidden(sourceId);
  const health = useLinkHealth(linkHealthSources(machines, sourceId));
  const knownIds = useKnownMachineIds();
  const machine = machines.find(({ info }) => info.installationId === sourceId);
  const rows = machine ? machineLinkRows(machines, health, sourceId, knownIds, Date.now()) : [];
  return (
    <View className="mt-5 gap-3">
      <SettingsSection title={`Linked from ${props.environmentLabel}`}>
        {hidden || !machine ? (
          <View className="gap-2 p-4">
            <Text className="text-foreground-muted">{machineLinksHiddenText(hidden ?? "reading")}</Text>
            {hidden === "failed" ? (
              <View className="flex-row">
                <Button label="Retry" size="compact" tone="secondary" onPress={() => refreshMachineLinks(sourceId)} />
              </View>
            ) : null}
          </View>
        ) : rows.length === 0 ? (
          <Text className="p-4 text-foreground-muted">No paired machines.</Text>
        ) : rows.map((row) => (
          <LinkRow key={row.targetId} row={row} sourceId={sourceId} sourceLabel={machine.label} />
        ))}
      </SettingsSection>
      {props.children}
    </View>
  );
}

function LinkRow(props: { readonly row: MachineLinkRow; readonly sourceId: string; readonly sourceLabel: string }) {
  const { row, sourceId, sourceLabel } = props;
  const machines = useMachineLinks();
  const { connect, connecting } = useConnectSolusMachine();
  const [isLinkingBack, setLinkingBack] = useState(false);
  const now = Date.now();
  const addresses = linkAddresses(row.pairing);
  const [route] = addresses;
  const details = [
    "Owner access",
    row.health ? linkExpiryText(row.health, now) : null,
    row.health ? lastReachedText(row.health, now) : null,
    linkedDateText(row.pairing),
  ].filter((part): part is string => part !== null);
  const source = machines.find(({ info }) => info.installationId === sourceId);
  const unlink = () =>
    Alert.alert(`Unlink ${row.targetLabel}?`, `Remove the pairing from ${sourceLabel}.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Unlink", style: "destructive", onPress: () => {
        if (!source?.isCurrent()) return;
        void source.api.hostsUnlink(row.targetId).catch(() => Alert.alert("Could not remove this machine link."));
      } },
    ]);
  const startLinkBack = async () => {
    setLinkingBack(true);
    try {
      const outcome = await linkBack(machines, sourceId, row.targetId);
      if (outcome === "failed") Alert.alert(`Could not link ${row.targetLabel} back to ${sourceLabel}.`);
      readLinkHealth([sourceId, row.targetId]);
    } finally {
      setLinkingBack(false);
    }
  };
  return (
    <View className="gap-2 p-4">
      <View className="flex-row items-center gap-2">
        <Text className="shrink text-base font-t3-bold text-foreground">{row.targetLabel}</Text>
        <StatusPill {...linkStateTone(row.shownState)} size="compact" />
      </View>
      <Text className="text-xs text-foreground-muted">
        {[row.back ? "Two-way link" : "One-way link", row.isLinkedOnly ? "Known only through a link" : null]
          .filter(Boolean).join(" · ")}
      </Text>
      <Text className="text-xs text-foreground-muted">{details.join(" · ")}</Text>
      {row.health?.lastError ? (
        <Text selectable className="text-xs text-danger-foreground">{row.health.lastError}</Text>
      ) : null}
      {row.back ? (
        <Text className="text-xs text-foreground-muted">
          {`${row.targetLabel} links back · ${machineLinkStateText(row.back.state)}`}
          {row.back.health?.lastError ? ` · ${row.back.health.lastError}` : ""}
        </Text>
      ) : null}
      {addresses.map(({ url, kind }) => (
        <Text key={url} selectable className="text-xs text-foreground-muted">{`${routeKindLabel(kind)} · ${url}`}</Text>
      ))}
      <View className="flex-row flex-wrap gap-2">
        {route ? (
          <Button label="Connect" size="compact" tone="secondary" disabled={connecting}
            onPress={() => void connect(row.targetId, row.targetLabel, route.url)} />
        ) : null}
        {row.canLinkBack ? (
          <Button label={isLinkingBack ? "Linking…" : "Link back"} size="compact" tone="secondary"
            disabled={isLinkingBack} onPress={() => void startLinkBack()} />
        ) : null}
        <Button label="Unlink" size="compact" tone="text" onPress={unlink} />
      </View>
    </View>
  );
}
