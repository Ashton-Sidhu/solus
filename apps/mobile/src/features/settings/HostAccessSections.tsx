import { useState } from "react";
import { View } from "react-native";

import {
  attachmentSummary,
  deliverySummary,
  hostCategoryLabel,
  insightsDetail,
  organizationDetail,
  organizationRows,
} from "@solus/client-core/organization-rows";
import { bestPairEndpoint, pairLink } from "@solus/client-core/pairing";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { ConnectionFormField } from "../connection/ConnectionFormField";
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
        {attachment ? (
          <SettingsValueRow icon="server.rack" label={attachment.label} value="" detail={attachment.description} />
        ) : null}
        {delivery ? <SettingsValueRow icon="tray.and.arrow.up" label="Delivery" value="" detail={delivery} /> : null}
        {rows.length === 0 ? (
          <SettingsValueRow icon="person.2" label="No organizations" value="" />
        ) : (
          rows.map((row) =>
            row.insightsManaged ? (
              <SettingsValueRow
                key={row.organizationId}
                icon="person.2"
                label={row.name}
                value=""
                detail={`${organizationDetail(row)} · ${insightsDetail(row)}`}
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
      <SettingsNote>
        {status.linked
          ? hostCategoryLabel(status.category)
          : `${hostCategoryLabel(status.category)} · not linked to Solus Cloud, so it stands in no organization.`}
      </SettingsNote>
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
        devices.map((device) => (
          <View key={device.id}>
            <SettingsValueRow
              icon="desktopcomputer"
              label={device.deviceLabel}
              value={relativeTime(new Date(device.connectedAt).toISOString())}
              detail={device.connectionCount > 1 ? `${device.connectionCount} connections` : undefined}
            />
            {device.deviceId ? (
              <SettingsActionRow
                icon="trash"
                label={`Revoke ${device.deviceLabel}`}
                tone="danger"
                loading={busy === `revoke:${device.deviceId}`}
                disabled={busy !== null}
                onPress={() => props.onRevoke(device.deviceId!)}
              />
            ) : null}
          </View>
        ))
      )}
    </SettingsSection>
  );
}

/** The hosts this host paired with, so its agents can start sessions there (docs/plans/cross-host-sessions.md §10). */
export function HostPairedHostsSection(props: {
  readonly access: HostAccessSnapshot;
  readonly onPair: (url: string, code: string) => Promise<boolean>;
  readonly onForget: (installationId: string) => void;
}) {
  const { pairedHosts, pairedHostsError, busy } = props.access;
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  if (!pairedHosts) {
    return pairedHostsError ? (
      <View className="gap-3">
        <SettingsSection title="Paired hosts">
          <SettingsValueRow icon="server.rack" label="Paired hosts" value="Unavailable" />
        </SettingsSection>
        <SettingsNote>{pairedHostsError}</SettingsNote>
      </View>
    ) : null;
  }
  const canPair = address.trim() !== "" && code.trim() !== "" && busy === null;
  const pair = async () => {
    if (!canPair) return;
    if (await props.onPair(address.trim(), code.trim())) {
      setAddress("");
      setCode("");
    }
  };

  return (
    <View className="gap-3">
      <SettingsSection title="Paired hosts">
        {pairedHosts.length === 0 ? (
          <SettingsValueRow icon="server.rack" label="No paired hosts" value="" />
        ) : (
          pairedHosts.map((host) => (
            <View key={host.installationId}>
              <SettingsValueRow
                icon="server.rack"
                label={host.label}
                value={relativeTime(new Date(host.pairedAt).toISOString())}
                detail={host.url}
              />
              <SettingsActionRow
                icon="trash"
                label={`Forget ${host.label}`}
                tone="danger"
                loading={busy === `forget-host:${host.installationId}`}
                disabled={busy !== null}
                onPress={() => props.onForget(host.installationId)}
              />
            </View>
          ))
        )}
      </SettingsSection>
      <View className="gap-3">
        <ConnectionFormField
          label="Address"
          value={address}
          onChangeText={setAddress}
          placeholder="http://100.64.0.2:7777"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <ConnectionFormField
          label="Code"
          value={code}
          onChangeText={setCode}
          placeholder="123456"
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          returnKeyType="go"
          onSubmitEditing={() => void pair()}
        />
      </View>
      <SettingsSection>
        <SettingsActionRow
          icon="plus"
          label="Pair this host"
          loading={busy === "pair-host"}
          disabled={!canPair}
          onPress={() => void pair()}
        />
      </SettingsSection>
      <SettingsNote>
        Agents on this host can start sessions on these hosts. On the other host, open Pair a device and enter its
        address and code here.
      </SettingsNote>
    </View>
  );
}
