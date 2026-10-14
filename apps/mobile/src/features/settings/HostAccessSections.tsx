import { ActivityIndicator, Pressable, View } from "react-native";

import {
  attachmentSummary,
  deliverySummary,
  hostCategoryLabel,
  insightsDetail,
  organizationDetail,
  organizationRows,
} from "@solus/client-core/organization-rows";
import { AppText as Text } from "../../components/AppText";
import { ListRowLayout } from "../../components/ListRowLayout";
import { bestPairEndpoint, pairLink } from "@solus/client-core/pairing";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { relativeTime } from "../../lib/time";
import { PairQrCode } from "./components/PairQrCode";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { canChangeAccess, networkNote, type HostAccessSnapshot } from "./host-access";

/**
 * The sections of a host's Access screen below its Solus Cloud link, in the
 * order the desktop and web Access tab shows them.
 */

export function HostOrganizationsSection(props: {
  readonly access: HostAccessSnapshot;
  readonly onInsightsOptIn: (organizationId: string, next: boolean) => void;
}) {
  const status = props.access.organizations;
  if (!status) {
    return props.access.organizationsError ? (
      <View className="gap-3">
        <SettingsSection title="Organizations">
          <SettingsValueRow icon="person.2" label="Organizations" value="Unavailable" />
        </SettingsSection>
        <SettingsNote>{props.access.organizationsError}</SettingsNote>
      </View>
    ) : null;
  }
  const rows = organizationRows(status);
  const attachment = attachmentSummary(status);
  const delivery = deliverySummary(status);

  return (
    <View className="gap-3">
      <SettingsSection title="Organizations">
        <ListRowLayout
          icon="desktopcomputer"
          label={hostCategoryLabel(status.category)}
          description={status.registered ? undefined : "Not registered to a Solus account, so it stands in no organization."}
        />
        {attachment ? <ListRowLayout icon="server.rack" label={attachment.label} description={attachment.description} /> : null}
        {delivery ? <ListRowLayout icon="tray.and.arrow.up" label="Delivery" description={delivery} /> : null}
        {rows.length === 0 ? (
          <ListRowLayout icon="person.2" label="No organizations" />
        ) : (
          rows.map((row) =>
            row.insightsManaged ? (
              <ListRowLayout
                key={row.organizationId}
                icon="person.2"
                label={row.name}
                description={`${organizationDetail(row)} · ${insightsDetail(row)}`}
              />
            ) : (
              <SettingsSwitchRow
                key={row.organizationId}
                icon="chart.bar.xaxis"
                label={row.name}
                subtitle={`${organizationDetail(row)} · Send this computer's Insights`}
                value={row.insightsOptedIn}
                disabled={props.access.busy === `insights:${row.organizationId}`}
                onValueChange={(next) => props.onInsightsOptIn(row.organizationId, next)}
              />
            ),
          )
        )}
      </SettingsSection>
    </View>
  );
}

export function HostNetworkSection(props: {
  readonly access: HostAccessSnapshot;
  readonly onRemoteAccess: (next: boolean) => void;
  readonly onTrustLocalNetwork: (next: boolean) => void;
}) {
  const { info, busy } = props.access;
  const locked = !canChangeAccess(info) || busy !== null;
  const address = info.remoteAccess
    ? props.access.endpoints.find((endpoint) => endpoint.kind !== "loopback")
    : undefined;

  return (
    <View className="gap-3">
      <SettingsSection title="Network">
        <SettingsSwitchRow
          icon="globe"
          label="Allow remote connections"
          subtitle="Remote devices must pair before connecting."
          value={info.remoteAccess}
          disabled={locked}
          onValueChange={props.onRemoteAccess}
        />
        {info.remoteAccess ? (
          <SettingsSwitchRow
            icon="house"
            label="Trust my local network"
            subtitle="Devices on your local network connect without a pairing code. Only enable on a network you control."
            value={info.trustLocalNetwork}
            disabled={locked}
            onValueChange={props.onTrustLocalNetwork}
          />
        ) : null}
        {address ? (
          <SettingsActionRow
            icon="doc.on.doc"
            label={`Copy http://${address.host}:${address.port}`}
            onPress={() => copyTextWithHaptic(`http://${address.host}:${address.port}`, { target: "address" })}
          />
        ) : null}
      </SettingsSection>
      <SettingsNote>{networkNote(info)}</SettingsNote>
    </View>
  );
}

export function HostPairingSection(props: { readonly access: HostAccessSnapshot; readonly onGenerate: () => void }) {
  const { pair, endpoints, busy } = props.access;
  const live = pair && pair.expiresAt > Date.now() ? pair : null;
  const endpoint = bestPairEndpoint(endpoints);
  const link = live && endpoint ? pairLink(endpoint, live.token) : null;
  const expires = live
    ? new Date(live.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <View className="gap-3">
      <SettingsSection title="Pairing">
        {live ? (
          <>
            <SettingsValueRow icon="qrcode.viewfinder" label="Pairing code" value={live.code} detail={`Expires at ${expires}`} />
            {link ? (
              <View className="p-4">
                <PairQrCode value={link} />
              </View>
            ) : null}
            {link ? (
              <SettingsActionRow
                icon="doc.on.doc"
                label="Copy pairing link"
                onPress={() => copyTextWithHaptic(link, { target: "pairing link" })}
              />
            ) : null}
          </>
        ) : null}
        <SettingsActionRow
          icon="plus"
          label={live ? "New code" : "Pair a device"}
          loading={busy === "pair"}
          disabled={busy !== null}
          onPress={props.onGenerate}
        />
      </SettingsSection>
      <SettingsNote>
        On the other device, scan the QR code or open the pairing link. Or enter this host's address and the code.
      </SettingsNote>
    </View>
  );
}

export function HostDevicesSection(props: {
  readonly access: HostAccessSnapshot;
  readonly onRevoke: (deviceId: string) => void;
}) {
  const { devices, busy } = props.access;
  return (
    <SettingsSection title="Devices with access">
      {devices.length === 0 ? (
        <SettingsValueRow icon="desktopcomputer" label="No devices" value="" detail="No devices are connected to this host." />
      ) : (
        devices.map((device) => {
          const deviceId = device.deviceId;
          const connected = `Connected ${relativeTime(new Date(device.connectedAt).toISOString())} ago`;
          return (
            <ListRowLayout
              key={device.id}
              icon="desktopcomputer"
              label={device.deviceLabel}
              description={
                device.connectionCount > 1 ? `${connected} · ${device.connectionCount} connections` : connected
              }
              accessory={
                deviceId ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Revoke ${device.deviceLabel}`}
                    disabled={busy !== null}
                    onPress={() => props.onRevoke(deviceId)}
                    className="min-w-20 items-center rounded-full bg-subtle px-3 py-2 active:opacity-70 disabled:opacity-40"
                  >
                    {busy === `revoke:${deviceId}` ? (
                      <ActivityIndicator colorClassName="accent-danger-foreground" />
                    ) : (
                      <Text className="text-sm font-t3-medium text-danger-foreground">Revoke</Text>
                    )}
                  </Pressable>
                ) : null
              }
            />
          );
        })
      )}
    </SettingsSection>
  );
}
